import type { V2Event } from "@opencode/client"
import type { TelegramBot } from "./bot.js"
import type { Sessions } from "./sessions.js"
import { tlog } from "./log.js"

interface TurnState {
  chatId: string
  messageID?: number
  buffer: Map<number, string>
  lastEdit: number
  flushTimer?: ReturnType<typeof setTimeout>
}

/**
 * Renders assistant output for telegram chats:
 *   execution.started        -> placeholder "…" message (turn begins)
 *   session.text.started     -> reset that ordinal's buffer
 *   session.text.delta       -> append, throttled edit-in-place
 *   session.text.ended       -> authoritative full text for the ordinal
 *   execution.succeeded      -> final edit (or "✅" for tool-only turns)
 *   execution.failed         -> ❌ error message
 *   execution.interrupted    -> ⏹ marker on the final edit
 *
 * Runs ONLY in the lease-holder process (otherwise every opencode process
 * would send duplicate Telegram messages). Sessions without a telegram
 * mapping (TUI conversations) are ignored.
 */
export class Renderer {
  private readonly turns = new Map<string, TurnState>()
  private disposed = false

  constructor(
    private readonly bot: TelegramBot,
    private readonly sessions: Sessions,
    private readonly throttleMs: number,
  ) {}

  async handle(ev: V2Event): Promise<void> {
    if (this.disposed) return
    const data = (ev as { data?: Record<string, unknown> }).data as
      | { sessionID?: string }
      | undefined
    const sessionID = data?.sessionID
    if (!sessionID) return

    switch (ev.type) {
      case "session.execution.started": {
        const chatId = await this.sessions.chatFor(sessionID)
        if (!chatId) return
        this.turns.set(sessionID, {
          chatId,
          buffer: new Map(),
          lastEdit: 0,
        })
        const msg = await this.bot.sendMessage(Number(chatId), "…")
        const state = this.turns.get(sessionID)
        if (state && msg) state.messageID = (msg as { message_id: number }).message_id
        return
      }
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const state = this.turns.get(sessionID)
        if (!state) return
        await this.reduce(state, ev)
        return
      }
      default:
        return
    }
  }

  private async reduce(state: TurnState, ev: V2Event): Promise<void> {
    const data = ev.data as Record<string, unknown> & { sessionID: string }
    switch (ev.type) {
      case "session.text.started": {
        state.buffer.set(Number(data.ordinal), "")
        return
      }
      case "session.text.delta": {
        const ord = Number(data.ordinal)
        state.buffer.set(ord, (state.buffer.get(ord) ?? "") + String(data.delta))
        await this.maybeFlush(state, false)
        return
      }
      case "session.text.ended": {
        state.buffer.set(Number(data.ordinal), String(data.text ?? ""))
        await this.maybeFlush(state, false)
        return
      }
      case "session.execution.succeeded": {
        await this.finalize(state, this.render(state) || "✅")
        return
      }
      case "session.execution.interrupted": {
        const body = this.render(state)
        await this.finalize(state, body ? `${body}\n\n⏹ interrupted` : "⏹ interrupted")
        return
      }
      case "session.execution.failed": {
        const err = (data.error ?? {}) as { name?: string; data?: { message?: string } }
        const msg = err.data?.message ?? err.name ?? "unknown error"
        const body = this.render(state)
        await this.finalize(state, body ? `${body}\n\n❌ ${msg}` : `❌ ${msg}`)
        tlog(`execution failed: ${msg}`)
        return
      }
    }
  }

  private render(state: TurnState): string {
    return [...state.buffer.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .filter((text) => text.length > 0)
      .join("\n\n")
  }

  private async maybeFlush(state: TurnState, force: boolean): Promise<void> {
    if (this.disposed) return
    const text = this.render(state)
    if (!text) return
    const now = Date.now()
    if (force || now - state.lastEdit >= this.throttleMs) {
      await this.flush(state, text)
      return
    }
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = undefined
        void this.flush(state, this.render(state)).catch(() => {})
      }, this.throttleMs - (now - state.lastEdit))
    }
  }

  private async flush(state: TurnState, text: string): Promise<void> {
    if (this.disposed) return
    state.lastEdit = Date.now()
    try {
      if (state.messageID === undefined) {
        const msg = (await this.bot.sendMessage(Number(state.chatId), text)) as {
          message_id: number
        }
        state.messageID = msg?.message_id
      } else {
        await this.edit(state.chatId, state.messageID, text)
      }
    } catch (err) {
      tlog(`flush error: ${String(err)}`)
    }
  }

  private async finalize(state: TurnState, text: string): Promise<void> {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer)
      state.flushTimer = undefined
    }
    await this.flush(state, text)
  }

  private async edit(chatId: string, messageID: number, text: string): Promise<void> {
    const chunk = text.length > 4096 ? `${text.slice(0, 4093)}...` : text
    try {
      await this.bot.editMessageText(Number(chatId), messageID, chunk)
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`edit error: ${message}`)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const state of this.turns.values()) {
      if (state.flushTimer) clearTimeout(state.flushTimer)
    }
    this.turns.clear()
  }
}
