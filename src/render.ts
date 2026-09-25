import type { V2Event } from "@opencode/client"
import type { TelegramBot } from "./bot.js"
import type { Sessions } from "./sessions.js"
import { tlog } from "./log.js"
import { esc, mdToHtml, splitHtml } from "./format.js"

export interface RendererOptions {
  /** max ms between streamed edits of one message */
  throttleMs: number
  /** per-action activity messages on/off */
  activity: boolean
  /** stream reasoning (thought tokens) as its own message, always visible */
  showReasoning: boolean
  /** hard cap on activity+reasoning messages per turn (burst guard) */
  maxActivityMessages: number
  /** answer rendering: telegram HTML (markdown) or raw */
  formatting: "html" | "plain"
  /** sendChatAction("typing") while the turn runs */
  typing: boolean
  /** [⏹ Stop] inline button on the placeholder */
  stopButton: boolean
}

interface ToolCall {
  name: string
  msgID?: number
  t0?: number
  /** terminal line arrived while the send was still queued */
  final?: string
}

interface ReasoningState {
  msgID?: number
  buf: string
  lastEdit: number
  final?: string
}

interface TurnState {
  chatId: string
  /** primary answer message (the placeholder — it morphs into the answer) */
  messageID?: number
  /** all answer chunks when the answer exceeds 4096 (0 === messageID) */
  chunkIDs: number[]
  partsLen: number
  /** keyed assistantMessageID:ordinal — insertion order = stream order */
  buffer: Map<string, string>
  lastEdit: number
  flushTimer?: ReturnType<typeof setTimeout>
  typingTimer?: ReturnType<typeof setInterval>
  tools: Map<string, ToolCall>
  reasoning: Map<string, ReasoningState>
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

const blockKey = (data: Record<string, unknown>): string =>
  `${String(data.assistantMessageID ?? "?")}:${String(data.ordinal ?? 0)}`

const callKey = (data: Record<string, unknown>): string =>
  `${String(data.assistantMessageID ?? "?")}:${String(data.id ?? "?")}`

/**
 * Renders assistant output for telegram chats.
 *
 * Message layout per turn:
 *   [🧠 one streamed message per reasoning block]
 *   [🔧 one message per tool action → edited to ✓/✗ with duration]
 *   [placeholder "…" with [⏹ Stop] — morphs into the streamed answer,
 *    split across chunks at block boundaries if >4096]
 *
 * Answer = LLM markdown -> md-to-telegram -> parse_mode HTML (plain
 * fallback on 400). Activity messages are silent; the placeholder notifies.
 * Typing indicator runs while the execution is live.
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
      const state: TurnState = {
        chatId,
        chunkIDs: [],
        partsLen: 0,
        buffer: new Map(),
        lastEdit: 0,
        tools: new Map(),
        reasoning: new Map(),
        activityCount: 0,
      }
      this.turns.set(sessionID, state)
      if (this.opts.typing) {
        void this.bot.sendChatAction(Number(chatId), "typing").catch(() => {})
        state.typingTimer = setInterval(() => {
          void this.bot.sendChatAction(Number(chatId), "typing").catch(() => {})
        }, 5000)
      }
      // placeholder IS the answer message: captured id, Stop button attached
      await this.enqueue(Number(chatId), () =>
        this.bot.sendMessage(Number(chatId), "…", { stopButton: this.opts.stopButton }).then((m) => {
          const id = (m as { message_id?: number })?.message_id
          if (id !== undefined) {
            state.messageID = id
            state.chunkIDs = [id]
          }
        }),
      )
      return
    }

    const state = this.turns.get(sessionID)
    if (!state) return
    await this.reduce(state, ev)
  }

  private hasRoom(state: TurnState): boolean {
    return state.activityCount < this.opts.maxActivityMessages
  }

  private htmlOn(): boolean {
    return this.opts.formatting === "html"
  }

  private async reduce(state: TurnState, ev: V2Event): Promise<void> {
    const data = ev.data as Record<string, unknown> & { sessionID: string }

    switch (ev.type) {
      // ---------- answer (raw markdown kept in buffer, converted at flush) ----------
      case "session.text.started":
        state.buffer.set(blockKey(data), "")
        return
      case "session.text.delta": {
        const key = blockKey(data)
        state.buffer.set(key, (state.buffer.get(key) ?? "") + String(data.delta))
        await this.maybeFlush(state)
        return
      }
      case "session.text.ended":
        state.buffer.set(blockKey(data), String(data.text ?? ""))
        await this.maybeFlush(state)
        return

      // ---------- reasoning: one always-visible message per block ----------
      case "session.reasoning.started": {
        if (!this.opts.showReasoning || !this.hasRoom(state)) return
        const key = blockKey(data)
        const existing = state.reasoning.get(key)
        if (existing) {
          existing.buf = "🧠"
          existing.lastEdit = 0
          existing.final = undefined
          return
        }
        state.activityCount++
        const r: ReasoningState = { buf: "🧠", lastEdit: 0 }
        state.reasoning.set(key, r)
        r.msgID = await this.sendPlain(state, "🧠", true)
        if (r.final !== undefined && r.msgID !== undefined) {
          const final = r.final
          r.final = undefined
          await this.editPlain(state, r.msgID, final)
        }
        return
      }
      case "session.reasoning.delta": {
        const r = state.reasoning.get(blockKey(data))
        if (!r) return
        r.buf += String(data.delta)
        if (r.msgID !== undefined && Date.now() - r.lastEdit >= this.opts.throttleMs) {
          r.lastEdit = Date.now()
          await this.editPlain(state, r.msgID, singleLine(r.buf, 4000))
        }
        return
      }
      case "session.reasoning.ended": {
        const r = state.reasoning.get(blockKey(data))
        if (!r) return
        const final = singleLine(String(data.text ?? r.buf), 4000)
        if (r.msgID !== undefined) await this.editPlain(state, r.msgID, final)
        else r.final = final
        return
      }

      // ---------- tools: one message per action, styled with <code> ----------
      case "session.tool.input.started": {
        if (!this.opts.activity) return
        const key = callKey(data)
        const call = state.tools.get(key)
        if (call) {
          call.name = String(data.name ?? call.name)
          return
        }
        state.tools.set(key, { name: String(data.name ?? "tool") })
        return
      }
      case "session.tool.input.ended":
      case "session.tool.called": {
        if (!this.opts.activity) return
        const key = callKey(data)
        let call = state.tools.get(key)
        if (!call) {
          call = { name: "tool" }
          state.tools.set(key, call)
        }
        if (call.msgID !== undefined || call.final !== undefined) return
        if (!this.hasRoom(state)) return
        state.activityCount++
        const inputText =
          ev.type === "session.tool.input.ended"
            ? String(data.text ?? "")
            : singleLine(JSON.stringify(data.input ?? {}) ?? "", 200)
        call.t0 = (ev as { created?: number }).created ?? Date.now()
        call.msgID = await this.sendTool(state, this.toolStartLine(call.name, inputText))
        if (call.final !== undefined && call.msgID !== undefined) {
          const final = call.final
          call.final = undefined
          await this.editTool(state, call.msgID, final)
        }
        return
      }
      case "session.tool.success": {
        const call = state.tools.get(callKey(data))
        if (!call) return
        const snippet = this.contentSnippet(data.content)
        const dur = call.t0 ? fmtDur(((ev as { created?: number }).created ?? Date.now()) - call.t0) : ""
        const line = this.toolEndLine(true, call.name, dur, snippet)
        if (call.msgID !== undefined) await this.editTool(state, call.msgID, line)
        else call.final = line
        return
      }
      case "session.tool.failed": {
        const call = state.tools.get(callKey(data))
        if (!call) return
        const dur = call.t0 ? fmtDur(((ev as { created?: number }).created ?? Date.now()) - call.t0) : ""
        const line = this.toolEndLine(false, call.name, dur, errText(data.error))
        if (call.msgID !== undefined) await this.editTool(state, call.msgID, line)
        else call.final = line
        return
      }

      // ---------- finalization ----------
      case "session.execution.succeeded": {
        this.stopTyping(state)
        await this.flushAnswer(state, this.render(state) || "✅", true)
        return
      }
      case "session.execution.interrupted": {
        this.stopTyping(state)
        const body = this.render(state)
        await this.flushAnswer(state, body ? `${body}\n\n⏹ interrupted` : "⏹ interrupted", true)
        return
      }
      case "session.execution.failed": {
        this.stopTyping(state)
        const msg = errText(data.error)
        const body = this.render(state)
        await this.flushAnswer(state, body ? `${body}\n\n❌ ${msg}` : `❌ ${msg}`, true)
        tlog(`execution failed: ${msg}`)
        return
      }
      default:
        return
    }
  }

  private stopTyping(state: TurnState): void {
    if (state.typingTimer) {
      clearInterval(state.typingTimer)
      state.typingTimer = undefined
    }
  }

  // ---- tool line builders (hand-built HTML when formatting=html) ----
  private toolStartLine(name: string, input: string): string {
    const n = singleLine(name, 40)
    const i = singleLine(input, 250)
    if (!this.htmlOn()) return i ? `🔧 ${n}: ${i}` : `🔧 ${n}`
    return i
      ? `🔧 <code>${esc(n)}</code>: <code>${esc(i)}</code>`
      : `🔧 <code>${esc(n)}</code>`
  }

  private toolEndLine(ok: boolean, name: string, dur: string, detail: string): string {
    const mark = ok ? "✓" : "✗"
    const n = singleLine(name, 40)
    const d = singleLine(detail, 150)
    const head = `${mark} <code>${esc(n)}</code>${dur ? ` · ${dur}` : ""}`
    if (!this.htmlOn()) return `${mark} ${n}${dur ? ` · ${dur}` : ""}${d ? ` · ${d}` : ""}`
    return d ? `${head} · ${esc(d)}` : head
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
    return texts
  }

  // ---- activity message helpers ----
  private async sendPlain(state: TurnState, text: string, silent: boolean): Promise<number | undefined> {
    let msgID: number | undefined
    await this.enqueue(Number(state.chatId), () =>
      this.bot.sendMessage(Number(state.chatId), text, { silent }).then((m) => {
        msgID = (m as { message_id?: number })?.message_id
      }),
    )
    return msgID
  }

  private async editPlain(state: TurnState, messageID: number, text: string): Promise<void> {
    if (this.disposed) return
    try {
      await this.bot.editMessageText(Number(state.chatId), messageID, text)
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`edit error: ${message}`)
    }
  }

  private async sendTool(state: TurnState, html: string): Promise<number | undefined> {
    let msgID: number | undefined
    const opts = { html: this.htmlOn(), silent: true }
    await this.enqueue(Number(state.chatId), () =>
      this.bot.sendMessage(Number(state.chatId), html, opts).then((m) => {
        msgID = (m as { message_id?: number })?.message_id
      }),
    )
    return msgID
  }

  private async editTool(state: TurnState, messageID: number, html: string): Promise<void> {
    if (this.disposed) return
    try {
      await this.bot.editMessageText(Number(state.chatId), messageID, html, {
        html: this.htmlOn(),
      })
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`tool edit error: ${message}`)
    }
  }

  // ---- answer message (markdown -> HTML, chunked at block boundaries) ----
  private render(state: TurnState): string {
    return [...state.buffer.values()].filter((text) => text.length > 0).join("\n\n")
  }

  private async maybeFlush(state: TurnState): Promise<void> {
    if (this.disposed) return
    const raw = this.render(state)
    if (!raw) return
    const now = Date.now()
    if (now - state.lastEdit >= this.opts.throttleMs) {
      await this.flushAnswer(state, raw, false)
      return
    }
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        state.flushTimer = undefined
        void this.flushAnswer(state, this.render(state), false).catch(() => {})
      }, this.opts.throttleMs - (now - state.lastEdit))
    }
  }

  private async flushAnswer(state: TurnState, raw: string, final: boolean): Promise<void> {
    if (this.disposed) return
    state.lastEdit = Date.now()
    if (state.flushTimer && final) {
      clearTimeout(state.flushTimer)
      state.flushTimer = undefined
    }

    const parts: string[] = this.htmlOn()
      ? splitHtml(mdToHtml(raw))
      : [raw.length > 4000 ? `${raw.slice(0, 3999)}…` : raw]
    const html = this.htmlOn()
    const grown = parts.length > state.partsLen

    try {
      // ensure a message exists for every part
      while (state.chunkIDs.length < parts.length) {
        if (state.chunkIDs.length === 0 && state.messageID !== undefined) {
          state.chunkIDs = [state.messageID]
          continue
        }
        const idx = state.chunkIDs.length
        const text = parts[idx] ?? ""
        let newID: number | undefined
        await this.enqueue(Number(state.chatId), () =>
          this.bot.sendMessage(Number(state.chatId), text, { html, silent: true }).then((m) => {
            newID = (m as { message_id?: number })?.message_id
          }),
        )
        if (newID === undefined) break
        state.chunkIDs.push(newID)
      }

      if (grown || parts.length === 1) {
        // render/refresh every chunk we own (prefix-stable; not-modified suppressed)
        for (let i = 0; i < state.chunkIDs.length && i < parts.length; i++) {
          await this.editChunk(state, state.chunkIDs[i] as number, parts[i] as string, i === 0)
        }
      } else {
        // only the last chunk is live
        const last = state.chunkIDs.length - 1
        const id = state.chunkIDs[last]
        if (id !== undefined && parts[last] !== undefined) {
          await this.editChunk(state, id, parts[last] as string, last === 0)
        }
      }
      state.partsLen = parts.length
    } catch (err) {
      tlog(`answer flush error: ${String(err)}`)
    }
  }

  private async editChunk(
    state: TurnState,
    messageID: number,
    text: string,
    isPrimary: boolean,
  ): Promise<void> {
    if (this.disposed) return
    try {
      await this.bot.editMessageText(Number(state.chatId), messageID, text, {
        html: this.htmlOn(),
        // primary edits clear the Stop keyboard (first answer text = buttons gone)
        ...(isPrimary ? { removeKeyboard: true } : {}),
      })
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`answer edit error: ${message}`)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const state of this.turns.values()) {
      if (state.flushTimer) clearTimeout(state.flushTimer)
      if (state.typingTimer) clearInterval(state.typingTimer)
      for (const r of state.reasoning.values()) if (r.final) void r.final
    }
    this.turns.clear()
  }
}
