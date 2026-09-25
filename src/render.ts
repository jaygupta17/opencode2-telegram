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
  final?: string
}

interface ReasoningState {
  msgID?: number
  buf: string
  lastEdit: number
  final?: string
}

/**
 * One Telegram message per assistant message's text. A turn that writes
 * "let me check…", runs tools, then writes a final answer produces two
 * separate text messages — each in its true chronological position
 * (between/after the tool messages), instead of one message that keeps
 * absorbing later content above the tools.
 */
interface TextBlock {
  /** ordinal -> raw markdown (authoritative text.ended replaces deltas) */
  parts: Map<number, string>
  /** telegram message ids (chunks when >4096) */
  msgIDs: number[]
  partsLen: number
  lastEdit: number
  timer?: ReturnType<typeof setTimeout>
  done?: boolean
}

interface TurnState {
  chatId: string
  placeholderID?: number
  /** the placeholder morphs into the FIRST text block only */
  placeholderUsed: boolean
  texts: Map<string, TextBlock>
  tools: Map<string, ToolCall>
  reasoning: Map<string, ReasoningState>
  activityCount: number
  typingTimer?: ReturnType<typeof setInterval>
  suffix?: string
  finalized: boolean
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

const msgKey = (data: Record<string, unknown>): string => String(data.assistantMessageID ?? "?")

const callKey = (data: Record<string, unknown>): string =>
  `${String(data.assistantMessageID ?? "?")}:${String(data.id ?? "?")}`

/**
 * Renders assistant output for telegram chats.
 *
 * Message order on the phone mirrors chronological order:
 *   [🧠 reasoning block -> own streamed message, per block]
 *   [🔧 tool action -> own message, edited to ✓/✗ with duration]
 *   [💬 text block -> own streamed message, per assistant message]
 *   execution end -> terminal marker appended to the last text block
 *   (tool-only turns: placeholder becomes "✅"; failures "❌ …")
 *
 * Text = markdown -> md-to-telegram -> parse_mode HTML (plain fallback on
 * 400). Activity messages are silent; the placeholder notifies. Typing
 * indicator runs while the execution is live.
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

  // ---- per-chat serialized sends (250ms gap, 429 + socket retry) ----
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
          if (/socket connection was closed|fetch failed|ECONNRESET|socket hang up/i.test(message)) {
            tlog("telegram socket blip — retrying once in 1s")
            return new Promise<void>((resolve) =>
              setTimeout(() => task().catch(() => {}).then(() => resolve()), 1000),
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
        placeholderUsed: false,
        texts: new Map(),
        tools: new Map(),
        reasoning: new Map(),
        activityCount: 0,
        finalized: false,
      }
      this.turns.set(sessionID, state)
      if (this.opts.typing) {
        void this.bot.sendChatAction(Number(chatId), "typing").catch(() => {})
        state.typingTimer = setInterval(() => {
          void this.bot.sendChatAction(Number(chatId), "typing").catch(() => {})
        }, 5000)
      }
      await this.enqueue(Number(chatId), () =>
        this.bot.sendMessage(Number(chatId), "…", { stopButton: this.opts.stopButton }).then((m) => {
          state.placeholderID = (m as { message_id?: number })?.message_id
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
      // ---------- text blocks: one telegram message per assistant message ----------
      case "session.text.started": {
        if (state.finalized) return
        const block = this.ensureBlock(state, msgKey(data))
        block.parts.set(Number(data.ordinal), "")
        return
      }
      case "session.text.delta": {
        if (state.finalized) return
        const block = this.ensureBlock(state, msgKey(data))
        const ord = Number(data.ordinal)
        block.parts.set(ord, (block.parts.get(ord) ?? "") + String(data.delta))
        await this.maybeFlushBlock(state, msgKey(data), block)
        return
      }
      case "session.text.ended": {
        if (state.finalized) return
        const block = this.ensureBlock(state, msgKey(data))
        block.parts.set(Number(data.ordinal), String(data.text ?? ""))
        await this.maybeFlushBlock(state, msgKey(data), block)
        return
      }

      // ---------- reasoning: one message per block ----------
      case "session.reasoning.started": {
        if (state.finalized || !this.opts.showReasoning || !this.hasRoom(state)) return
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
        r.msgID = await this.sendActivity(state, "🧠", false)
        if (r.final !== undefined && r.msgID !== undefined) {
          const final = r.final
          r.final = undefined
          await this.editActivity(state, r.msgID, final, false)
        }
        return
      }
      case "session.reasoning.delta": {
        if (state.finalized) return
        const r = state.reasoning.get(blockKey(data))
        if (!r) return
        r.buf += String(data.delta)
        if (r.msgID !== undefined && Date.now() - r.lastEdit >= this.opts.throttleMs) {
          r.lastEdit = Date.now()
          await this.editActivity(state, r.msgID, singleLine(r.buf, 4000), false)
        }
        return
      }
      case "session.reasoning.ended": {
        const r = state.reasoning.get(blockKey(data))
        if (!r) return
        const final = singleLine(String(data.text ?? r.buf), 4000)
        if (r.msgID !== undefined) await this.editActivity(state, r.msgID, final, false)
        else r.final = final
        return
      }

      // ---------- tools: one message per action ----------
      case "session.tool.input.started": {
        if (state.finalized || !this.opts.activity) return
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
        if (state.finalized || !this.opts.activity) return
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
        call.msgID = await this.sendActivity(state, this.toolStartLine(call.name, inputText), this.htmlOn())
        if (call.final !== undefined && call.msgID !== undefined) {
          const final = call.final
          call.final = undefined
          await this.editActivity(state, call.msgID, final, this.htmlOn())
        }
        return
      }
      case "session.tool.success": {
        const call = state.tools.get(callKey(data))
        if (!call) return
        const snippet = this.contentSnippet(data.content)
        const dur = call.t0 ? fmtDur(((ev as { created?: number }).created ?? Date.now()) - call.t0) : ""
        const line = this.toolEndLine(true, call.name, dur, snippet)
        if (call.msgID !== undefined) await this.editActivity(state, call.msgID, line, this.htmlOn())
        else call.final = line
        return
      }
      case "session.tool.failed": {
        const call = state.tools.get(callKey(data))
        if (!call) return
        const dur = call.t0 ? fmtDur(((ev as { created?: number }).created ?? Date.now()) - call.t0) : ""
        const line = this.toolEndLine(false, call.name, dur, errText(data.error))
        if (call.msgID !== undefined) await this.editActivity(state, call.msgID, line, this.htmlOn())
        else call.final = line
        return
      }

      // ---------- finalization ----------
      case "session.execution.succeeded": {
        await this.finalizeAll(state, undefined)
        return
      }
      case "session.execution.interrupted": {
        await this.finalizeAll(state, "⏹ interrupted")
        return
      }
      case "session.execution.failed": {
        const msg = errText(data.error)
        tlog(`execution failed: ${msg}`)
        await this.finalizeAll(state, `❌ ${msg}`)
        return
      }
      default:
        return
    }
  }

  private ensureBlock(state: TurnState, key: string): TextBlock {
    const existing = state.texts.get(key)
    if (existing) return existing
    const block: TextBlock = { parts: new Map(), msgIDs: [], partsLen: 0, lastEdit: 0 }
    state.texts.set(key, block)
    return block
  }

  private blockRaw(block: TextBlock): string {
    return [...block.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .filter((text) => text.length > 0)
      .join("\n\n")
  }

  // ---- tool lines ----
  private toolStartLine(name: string, input: string): string {
    const n = singleLine(name, 40)
    const i = singleLine(input, 250)
    if (!this.htmlOn()) return i ? `🔧 ${n}: ${i}` : `🔧 ${n}`
    return i ? `🔧 <code>${esc(n)}</code>: <code>${esc(i)}</code>` : `🔧 <code>${esc(n)}</code>`
  }

  private toolEndLine(ok: boolean, name: string, dur: string, detail: string): string {
    const mark = ok ? "✓" : "✗"
    const n = singleLine(name, 40)
    const d = singleLine(detail, 150)
    if (!this.htmlOn()) {
      return `${mark} ${n}${dur ? ` · ${dur}` : ""}${d ? ` · ${d}` : ""}`
    }
    const head = `${mark} <code>${esc(n)}</code>${dur ? ` · ${dur}` : ""}`
    return d ? `${head} · ${esc(d)}` : head
  }

  private contentSnippet(content: unknown): string {
    if (!Array.isArray(content)) return ""
    return content
      .map((c) => {
        const item = c as { type?: string; text?: string }
        return item?.type === "text" ? (item.text ?? "") : ""
      })
      .filter(Boolean)
      .join(" ")
  }

  // ---- message helpers ----
  private async sendActivity(state: TurnState, text: string, html: boolean): Promise<number | undefined> {
    let msgID: number | undefined
    await this.enqueue(Number(state.chatId), () =>
      this.bot.sendMessage(Number(state.chatId), text, { html, silent: true }).then((m) => {
        msgID = (m as { message_id?: number })?.message_id
      }),
    )
    return msgID
  }

  private async editActivity(
    state: TurnState,
    messageID: number,
    text: string,
    html: boolean,
  ): Promise<void> {
    if (this.disposed) return
    try {
      await this.bot.editMessageText(Number(state.chatId), messageID, text, { html })
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`edit error: ${message}`)
    }
  }

  // ---- text blocks: markdown -> HTML, chunked at block boundaries ----
  private async maybeFlushBlock(state: TurnState, key: string, block: TextBlock): Promise<void> {
    if (this.disposed) return
    const raw = this.blockRaw(block)
    if (!raw) return
    const now = Date.now()
    if (now - block.lastEdit >= this.opts.throttleMs) {
      await this.flushBlock(state, key, block)
      return
    }
    if (!block.timer) {
      block.timer = setTimeout(() => {
        block.timer = undefined
        void this.flushBlock(state, key, block).catch(() => {})
      }, this.opts.throttleMs - (now - block.lastEdit))
    }
  }

  private async flushBlock(state: TurnState, key: string, block: TextBlock): Promise<void> {
    if (this.disposed || !block || key === undefined) return
    block.lastEdit = Date.now()
    const raw = this.blockRaw(block)
    const parts: string[] = this.htmlOn()
      ? splitHtml(mdToHtml(raw))
      : [raw.length > 4000 ? `${raw.slice(0, 3999)}…` : raw]
    const html = this.htmlOn()
    const grown = parts.length > block.partsLen

    try {
      // first message: morph the placeholder if it's still unused
      if (block.msgIDs.length === 0) {
        if (!state.placeholderUsed && state.placeholderID !== undefined) {
          block.msgIDs.push(state.placeholderID)
          state.placeholderUsed = true
        } else {
          let newID: number | undefined
          await this.enqueue(Number(state.chatId), () =>
            this.bot.sendMessage(Number(state.chatId), parts[0] ?? "", { html, silent: true }).then(
              (m) => {
                newID = (m as { message_id?: number })?.message_id
              },
            ),
          )
          if (newID !== undefined) block.msgIDs.push(newID)
        }
      }
      // extra chunks when >4096
      while (block.msgIDs.length < parts.length) {
        const idx = block.msgIDs.length
        let newID: number | undefined
        await this.enqueue(Number(state.chatId), () =>
          this.bot.sendMessage(Number(state.chatId), parts[idx] ?? "", { html, silent: true }).then(
            (m) => {
              newID = (m as { message_id?: number })?.message_id
            },
          ),
        )
        if (newID === undefined) break
        block.msgIDs.push(newID)
      }

      if (grown || parts.length === 1) {
        for (let i = 0; i < block.msgIDs.length && i < parts.length; i++) {
          await this.editChunk(state, block.msgIDs[i] as number, parts[i] as string)
        }
      } else {
        const last = block.msgIDs.length - 1
        const id = block.msgIDs[last]
        if (id !== undefined && parts[last] !== undefined) {
          await this.editChunk(state, id, parts[last] as string)
        }
      }
      block.partsLen = parts.length
    } catch (err) {
      tlog(`text flush error: ${String(err)}`)
    }
  }

  private async editChunk(state: TurnState, messageID: number, text: string): Promise<void> {
    if (this.disposed) return
    try {
      await this.bot.editMessageText(Number(state.chatId), messageID, text, {
        html: this.htmlOn(),
        // the placeholder keeps the Stop button until its first text edit
        removeKeyboard: messageID === state.placeholderID,
      })
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`text edit error: ${message}`)
    }
  }

  // ---- finalization ----
  private async finalizeAll(state: TurnState, suffix: string | undefined): Promise<void> {
    if (state.finalized) return
    state.finalized = true
    if (state.typingTimer) {
      clearInterval(state.typingTimer)
      state.typingTimer = undefined
    }
    state.suffix = suffix

    const keys = [...state.texts.keys()]
    if (keys.length === 0) {
      // tool-only or empty turn: placeholder becomes the outcome
      const text = suffix ?? "✅"
      if (state.placeholderID !== undefined && !state.placeholderUsed) {
        state.placeholderUsed = true
        await this.editChunk(state, state.placeholderID, this.htmlOn() ? esc(text) : text)
      }
      return
    }

    for (const [i, key] of keys.entries()) {
      const block = state.texts.get(key)
      if (!block) continue
      for (const timer of [block.timer]) if (timer) clearTimeout(timer)
      block.timer = undefined
      if (i === keys.length - 1 && suffix) {
        // append the terminal marker to the last block as a raw line
        block.parts.set(-1, suffix)
      }
      await this.flushBlock(state, key, block)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const state of this.turns.values()) {
      if (state.typingTimer) clearInterval(state.typingTimer)
      for (const block of state.texts.values()) if (block.timer) clearTimeout(block.timer)
    }
    this.turns.clear()
  }
}
