import type { V2Event } from "@opencode/client"
import type { TelegramBot } from "./bot.js"
import type { Sessions } from "./sessions.js"
import { tlog } from "./log.js"

export interface RendererOptions {
  /** max ms between streamed edits of one message */
  throttleMs: number
  /** per-action activity messages on/off */
  activity: boolean
  /** stream reasoning (thought tokens) as its own message */
  showReasoning: boolean
  /** hard cap on activity+reasoning messages per turn (burst guard) */
  maxActivityMessages: number
}

interface ToolCall {
  name: string
  msgID?: number
  t0?: number
}

interface ReasoningState {
  msgID?: number
  buf: string
  lastEdit: number
  timer?: ReturnType<typeof setTimeout>
}

interface TurnState {
  chatId: string
  messageID?: number
  buffer: Map<number, string>
  lastEdit: number
  flushTimer?: ReturnType<typeof setTimeout>
  tools: Map<string, ToolCall>
  reasoning: Map<number, ReasoningState>
  activityCount: number
}

const singleLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const errText = (err: unknown): string => {
  const e = err as { message?: string; type?: string; name?: string; data?: { message?: string } }
  return e?.message ?? e?.data?.message ?? e?.name ?? e?.type ?? "error"
}

const fmtDur = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * Renders assistant output for telegram chats (Phase 3b):
 *
 *   execution.started        -> placeholder "…" answer message
 *   reasoning.*              -> ONE message per reasoning segment, streamed
 *   tool.input.started       -> remember call id -> tool name
 *   tool.input.ended/called  -> ONE new message per action: "🔧 name: input"
 *   tool.success/failed      -> edit that message: "✓/✗ name · dur · snippet"
 *   text.*                   -> answer message, throttled edit-in-place
 *   execution.succeeded/failed/interrupted -> finalization
 *
 * Sends are rate-limited per chat through a queue (250ms gap, 429 retry).
 * Runs ONLY in the lease-holder process.
 */
export class Renderer {
  private readonly turns = new Map<string, TurnState>()
  private readonly queues = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    private readonly bot: TelegramBot,
    private readonly sessions: Sessions,
    private readonly opts: RendererOptions,
  ) {}

  // ---- per-chat serialized sends (250ms gap, single 429 retry) ----
  private enqueue(chatId: number, task: () => Promise<unknown>): Promise<void> {
    const key = String(chatId)
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev
      .then(() => new Promise<void>((r) => setTimeout(r, 250)))
      .then(() =>
        task().catch((err: unknown) => {
          const message = String(err)
          if (message.includes("429") || message.toLowerCase().includes("too many requests")) {
            const secs = Number(/retry after (\d+)/i.exec(message)?.[1] ?? "3")
            tlog(`telegram 429 — retrying in ${secs}s`)
            return new Promise<void>((resolve) =>
              setTimeout(() => task().catch(() => {}).then(() => resolve()), secs * 1000),
            )
          }
          throw err
        }),
      )
      .then(
        () => {},
        (err: unknown) => {
          tlog(`send error: ${String(err)}`)
        },
      )
    this.queues.set(key, next)
    return next
  }

  async handle(ev: V2Event): Promise<void> {
    if (this.disposed) return
    const data = (ev as { data?: Record<string, unknown> }).data as
      | { sessionID?: string }
      | undefined
    const sessionID = data?.sessionID
    if (!sessionID) return

    if (ev.type === "session.execution.started") {
      const chatId = await this.sessions.chatFor(sessionID)
      if (!chatId) return
      this.turns.set(sessionID, {
        chatId,
        buffer: new Map(),
        lastEdit: 0,
        tools: new Map(),
        reasoning: new Map(),
        activityCount: 0,
      })
      const state = this.turns.get(sessionID)
      if (!state) return
      await this.enqueue(Number(chatId), () => this.bot.sendMessage(Number(chatId), "…")).then(() => {})
      return
    }

    const state = this.turns.get(sessionID)
    if (!state) return
    await this.reduce(state, ev)
  }

  private hasRoom(state: TurnState): boolean {
    return state.activityCount < this.opts.maxActivityMessages
  }

  private async reduce(state: TurnState, ev: V2Event): Promise<void> {
    const data = ev.data as Record<string, unknown> & { sessionID: string }

    switch (ev.type) {
      // ---------- answer ----------
      case "session.text.started":
        state.buffer.set(Number(data.ordinal), "")
        return
      case "session.text.delta": {
        const ord = Number(data.ordinal)
        state.buffer.set(ord, (state.buffer.get(ord) ?? "") + String(data.delta))
        await this.maybeFlush(state, false)
        return
      }
      case "session.text.ended":
        state.buffer.set(Number(data.ordinal), String(data.text ?? ""))
        await this.maybeFlush(state, false)
        return

      // ---------- reasoning: one message per segment ----------
      case "session.reasoning.started": {
        if (!this.opts.showReasoning || !this.hasRoom(state)) return
        const ord = Number(data.ordinal)
        if (state.reasoning.has(ord)) return
        state.activityCount++
        const r: ReasoningState = { buf: "🧠", lastEdit: 0 }
        state.reasoning.set(ord, r)
        await this.sendActivity(state, "🧠").then((msgID) => {
          r.msgID = msgID
        })
        return
      }
      case "session.reasoning.delta": {
        const r = state.reasoning.get(Number(data.ordinal))
        if (!r) return
        r.buf += String(data.delta)
        if (r.msgID !== undefined && Date.now() - r.lastEdit >= this.opts.throttleMs) {
          r.lastEdit = Date.now()
          await this.editActivity(state, r.msgID, `🧠 ${singleLine(r.buf, 4000)}`)
        }
        return
      }
      case "session.reasoning.ended": {
        const r = state.reasoning.get(Number(data.ordinal))
        if (!r || r.msgID === undefined) return
        const final = String(data.text ?? r.buf)
        await this.editActivity(state, r.msgID, `🧠 ${singleLine(final, 4000)}`)
        return
      }

      // ---------- tools: one message per action ----------
      case "session.tool.input.started": {
        if (!this.opts.activity) return
        const call = state.tools.get(String(data.id))
        if (call) {
          call.name = String(data.name ?? call.name)
          return
        }
        state.tools.set(String(data.id), { name: String(data.name ?? "tool") })
        return
      }
      case "session.tool.input.ended":
      case "session.tool.called": {
        if (!this.opts.activity) return
        const id = String(data.id)
        let call = state.tools.get(id)
        if (!call) {
          call = { name: "tool" }
          state.tools.set(id, call)
        }
        if (call.msgID !== undefined) return // already sent
        if (!this.hasRoom(state)) return
        state.activityCount++
        const inputText =
          ev.type === "session.tool.input.ended"
            ? String(data.text ?? "")
            : singleLine(JSON.stringify(data.input ?? {}) ?? "", 200)
        const label = inputText
          ? `${call.name}: ${singleLine(inputText, 250)}`
          : call.name
        call.t0 = (ev as { created?: number }).created ?? Date.now()
        call.msgID = await this.sendActivity(state, `🔧 ${label}`)
        return
      }
      case "session.tool.success": {
        const call = state.tools.get(String(data.id))
        if (!call) return
        const snippet = this.contentSnippet(data.content)
        const dur = call.t0 ? fmtDur(((ev as { created?: number }).created ?? Date.now()) - call.t0) : ""
        const line = `✓ ${call.name}${dur ? ` · ${dur}` : ""}${snippet ? ` · ${snippet}` : ""}`
        if (call.msgID !== undefined) await this.editActivity(state, call.msgID, line)
        return
      }
      case "session.tool.failed": {
        const call = state.tools.get(String(data.id))
        if (!call) return
        const dur = call.t0 ? fmtDur(((ev as { created?: number }).created ?? Date.now()) - call.t0) : ""
        const line = `✗ ${call.name}${dur ? ` · ${dur}` : ""} · ${singleLine(errText(data.error), 250)}`
        if (call.msgID !== undefined) await this.editActivity(state, call.msgID, line)
        return
      }

      // ---------- finalization ----------
      case "session.execution.succeeded":
        await this.finalize(state, this.render(state) || "✅")
        return
      case "session.execution.interrupted": {
        const body = this.render(state)
        await this.finalize(state, body ? `${body}\n\n⏹ interrupted` : "⏹ interrupted")
        return
      }
      case "session.execution.failed": {
        const msg = errText(data.error)
        const body = this.render(state)
        await this.finalize(state, body ? `${body}\n\n❌ ${msg}` : `❌ ${msg}`)
        tlog(`execution failed: ${msg}`)
        return
      }
      default:
        return
    }
  }

  private contentSnippet(content: unknown): string {
    if (!Array.isArray(content)) return ""
    const texts = content
      .map((c) => {
        const item = c as { type?: string; text?: string }
        return item?.type === "text" ? (item.text ?? "") : ""
      })
      .filter(Boolean)
      .join(" ")
    return texts ? singleLine(texts, 150) : ""
  }

  // ---- activity messages (go through the per-chat send queue) ----
  private async sendActivity(state: TurnState, text: string): Promise<number | undefined> {
    let msgID: number | undefined
    await this.enqueue(Number(state.chatId), () =>
      this.bot.sendMessage(Number(state.chatId), text).then((m) => {
        msgID = (m as { message_id?: number })?.message_id
      }),
    )
    return msgID
  }

  private async editActivity(state: TurnState, messageID: number, text: string): Promise<void> {
    if (this.disposed) return
    try {
      await this.bot.editMessageText(Number(state.chatId), messageID, text)
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`activity edit error: ${message}`)
    }
  }

  // ---- answer message ----
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
    if (force || now - state.lastEdit >= this.opts.throttleMs) {
      await this.flush(state, text)
      return
    }
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = undefined
        void this.flush(state, this.render(state)).catch(() => {})
      }, this.opts.throttleMs - (now - state.lastEdit))
    }
  }

  private async flush(state: TurnState, text: string): Promise<void> {
    if (this.disposed) return
    state.lastEdit = Date.now()
    try {
      if (state.messageID === undefined) {
        await this.enqueue(Number(state.chatId), () =>
          this.bot.sendMessage(Number(state.chatId), text).then((m) => {
            state.messageID = (m as { message_id?: number })?.message_id
          }),
        )
      } else {
        await this.bot.editMessageText(Number(state.chatId), state.messageID, text).catch(
          (err: unknown) => {
            const message = String(err)
            if (!message.includes("message is not modified")) tlog(`flush error: ${message}`)
          },
        )
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
    for (const r of state.reasoning.values()) {
      if (r.timer) clearTimeout(r.timer)
    }
    await this.flush(state, text)
  }

  dispose(): void {
    this.disposed = true
    for (const state of this.turns.values()) {
      if (state.flushTimer) clearTimeout(state.flushTimer)
      for (const r of state.reasoning.values()) if (r.timer) clearTimeout(r.timer)
    }
    this.turns.clear()
  }
}
