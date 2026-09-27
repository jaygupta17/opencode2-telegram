import type { V2Event } from "@opencode/client"
import { stat } from "node:fs/promises"
import type { TelegramBot } from "./bot.js"
import type { Sessions } from "./sessions.js"
import { tlog } from "./log.js"
import { esc, mdToHtml, splitHtml } from "./format.js"

export interface RendererOptions {
  /** max ms between streamed edits of one message */
  throttleMs: number
  /** per-action blocks on/off (tool call/result, reasoning) */
  activity: boolean
  /** stream reasoning (thought tokens) as its own block */
  showReasoning: boolean
  /** hard cap on activity blocks per turn (burst guard) */
  maxActivityMessages: number
  /** text rendering: telegram HTML (markdown) or raw */
  formatting: "html" | "plain"
  /** sendChatAction("typing") while the turn runs */
  typing: boolean
  /** [⏹ Stop] inline button on the placeholder */
  stopButton: boolean
  /** max chars of tool output shown inside the expandable blockquote */
  toolOutputChars: number
  /** auto-send local images referenced in the final answer */
  autoImages: boolean
  /** text streaming transport: native drafts or live message edits */
  streaming: "drafts" | "edits"
}

/**
 * STRICT BLOCK MODEL — one block = one Telegram message.
 *
 *   thinking block  -> own message, streams (started->delta->ended), then frozen
 *   tool call block -> own message, sent complete, frozen
 *   tool result     -> own message, sent complete, frozen (never an edit of the call)
 *   text block      -> own message per assistant message, streams, then frozen
 *
 * A message is edited ONLY while its own block is still streaming. Blocks are
 * never morphed into one another and never merged. Message order = event
 * order (all sends go through one FIFO queue per chat).
 *
 * The "…" placeholder is NOT a block: it is a status widget carrying the
 * [⏹ Stop] button and is DELETED when the turn ends (never morphs into
 * content). Terminal states (interrupted/failed) are their own messages.
 *
 * Runs ONLY in the lease-holder process.
 */
export class Renderer {
  private readonly turns = new Map<string, TurnState>()
  private readonly queues = new Map<string, Promise<void>>()
  /** last user prompt message per chat — gets the outcome reaction */
  private readonly lastPrompt = new Map<string, number>()
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

  // =====================================================================
  async handle(ev: V2Event): Promise<void> {
    if (this.disposed) return
    const data = (ev as { data?: Record<string, unknown> }).data as
      | { sessionID?: string }
      | undefined
    const sessionID = data?.sessionID
    if (!sessionID) return

    if (ev.type === "permission.asked") {
      await this.permissionCard(data)
      return
    }

    if (ev.type === "session.execution.started") {
      const chatId = await this.sessions.chatFor(sessionID)
      if (!chatId) return
      const state: TurnState = {
        chatId,
        reasoning: new Map(),
        tools: new Map(),
        texts: new Map(),
        activityCount: 0,
        blocks: 0,
        finalized: false,
      }
      this.turns.set(sessionID, state)
      if (this.opts.streaming === "drafts") {
        state.draftID = (Date.now() % 2_000_000_000) + 1
        void this.bot
          .sendMessageDraft(Number(chatId), state.draftID, "", { canStop: this.opts.stopButton })
          .catch((err: unknown) => tlog(`draft placeholder failed: ${String(err)}`))
      } else {
        if (this.opts.typing) {
          void this.bot.sendChatAction(Number(chatId), "typing").catch(() => {})
          state.typingTimer = setInterval(() => {
            void this.bot.sendChatAction(Number(chatId), "typing").catch(() => {})
          }, 5000)
        }
        await this.send(state, "…", { stopButton: this.opts.stopButton }).then((m) => {
          state.placeholderID = (m as { message_id?: number })?.message_id
        })
      }
      return
    }

    const state = this.turns.get(sessionID)
    if (!state) return
    await this.reduce(state, ev)
  }

  private hasRoom(state: TurnState): boolean {
    return state.activityCount < this.opts.maxActivityMessages
  }

  // -------------------- permission cards --------------------
  private async permissionCard(data: Record<string, unknown>): Promise<void> {
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    const id = typeof data.id === "string" ? data.id : ""
    if (!sessionID || !id) return
    const chatId = await this.sessions.chatFor(sessionID)
    if (!chatId) return
    this.sessions.rememberRequest(id, sessionID)

    const action = String(data.action ?? "action")
    const resources = Array.isArray(data.resources) ? (data.resources as unknown[]).map(String) : []
    const lines = [`🔐 <b>${esc(action)}</b> permission needed`]
    if (resources.length > 0) {
      lines.push(`<code>${esc(singleLine(resources.join(", "), 400))}</code>`)
    }
    if (data.message) lines.push(esc(String(data.message)))

    const keyboard = {
      inline_keyboard: [
        [{ text: "✅ Allow once", callback_data: `perm:once:${id}` }],
        [{ text: "♾️ Allow always", callback_data: `perm:always:${id}` }],
        [{ text: "🚫 Reject", callback_data: `perm:reject:${id}` }],
      ],
    }
    await this.enqueue(Number(chatId), () =>
      this.bot.sendMessage(Number(chatId), lines.join("\n"), { html: true, keyboard }),
    )
  }

  private htmlOn(): boolean {
    return this.opts.formatting === "html"
  }

  // =====================================================================
  private async reduce(state: TurnState, ev: V2Event): Promise<void> {
    const data = ev.data as Record<string, unknown> & { sessionID: string }

    // drafts mode: an open text block logically ends when a different block kind starts
    if (
      this.opts.streaming === "drafts" &&
      (ev.type.startsWith("session.tool.") || ev.type === "session.reasoning.started")
    ) {
      await this.closeOpenTexts(state)
    }

    switch (ev.type) {
      // -------------------- thinking blocks (expandable blockquote) --------------------
      case "session.reasoning.started": {
        if (state.finalized || !this.opts.showReasoning || !this.hasRoom(state)) return
        const key = blockKey(data)
        if (state.reasoning.has(key)) return
        state.activityCount++
        state.blocks++
        const r: ReasoningState = { msgIDs: [], partsLen: 0, buf: "", lastEdit: 0 }
        state.reasoning.set(key, r)
        const id = await this.sendActivity(state, "🧠")
        if (id !== undefined) r.msgIDs.push(id)
        return
      }
      case "session.reasoning.delta": {
        if (state.finalized) return
        const r = state.reasoning.get(blockKey(data))
        if (!r) return
        r.buf += String(data.delta)
        await this.maybeFlushReasoning(state, r)
        return
      }
      case "session.reasoning.ended": {
        if (state.finalized) return
        const r = state.reasoning.get(blockKey(data))
        if (!r) return
        r.buf = String(data.text ?? r.buf)
        if (r.timer) {
          clearTimeout(r.timer)
          r.timer = undefined
        }
        await this.flushReasoning(state, r)
        return
      }

      // -------------------- tool call blocks --------------------
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
        if (state.finalized || !this.opts.activity) return
        const key = callKey(data)
        let call = state.tools.get(key)
        if (!call) {
          call = { name: "tool" }
          state.tools.set(key, call)
        }
        if (call.callMsgID !== undefined) return // call block already sent
        if (!this.hasRoom(state)) return
        state.activityCount++
        state.blocks++
        const inputText =
          ev.type === "session.tool.input.ended"
            ? String(data.text ?? "")
            : singleLine(JSON.stringify(data.input ?? {}) ?? "", 200)
        call.t0 = (ev as { created?: number }).created ?? Date.now()
        call.callMsgID = await this.sendActivity(state, this.toolCallLine(call.name, inputText))
        return
      }

      // -------------------- tool result blocks --------------------
      case "session.tool.success": {
        if (state.finalized || !this.opts.activity) return
        const key = callKey(data)
        const call = state.tools.get(key) ?? { name: "tool" }
        if (call.resultSent) return
        if (!this.hasRoom(state)) return
        state.activityCount++
        state.blocks++
        call.resultSent = true
        const output = this.outputText(data.content)
        const dur = call.t0 ? fmtDur(((ev as { created?: number }).created ?? Date.now()) - call.t0) : ""
        for (const part of this.toolResultParts(true, call.name, dur, output)) {
          await this.sendActivity(state, part)
        }
        return
      }
      case "session.tool.failed": {
        if (state.finalized || !this.opts.activity) return
        const key = callKey(data)
        const call = state.tools.get(key) ?? { name: "tool" }
        if (call.resultSent) return
        if (!this.hasRoom(state)) return
        state.activityCount++
        state.blocks++
        call.resultSent = true
        const dur = call.t0 ? fmtDur(((ev as { created?: number }).created ?? Date.now()) - call.t0) : ""
        for (const part of this.toolResultParts(false, call.name, dur, errText(data.error))) {
          await this.sendActivity(state, part)
        }
        return
      }

      // -------------------- text blocks --------------------
      case "session.text.started": {
        if (state.finalized) return
        await this.closeOpenTexts(state, msgKey(data))
        const block = this.ensureText(state, msgKey(data))
        block.parts.set(Number(data.ordinal), "")
        return
      }
      case "session.text.delta": {
        if (state.finalized) return
        const block = this.ensureText(state, msgKey(data))
        const ord = Number(data.ordinal)
        block.parts.set(ord, (block.parts.get(ord) ?? "") + String(data.delta))
        await this.maybeFlushText(state, msgKey(data), block)
        return
      }
      case "session.text.ended": {
        if (state.finalized) return
        const block = this.ensureText(state, msgKey(data))
        block.parts.set(Number(data.ordinal), String(data.text ?? ""))
        await this.maybeFlushText(state, msgKey(data), block)
        return
      }

      // -------------------- terminal --------------------
      case "session.execution.succeeded": {
        await this.finish(state, undefined, "ok")
        return
      }
      case "session.execution.interrupted": {
        await this.finish(state, "⏹ interrupted", "interrupt")
        return
      }
      case "session.execution.failed": {
        const msg = errText(data.error)
        tlog(`execution failed: ${msg}`)
        await this.finish(state, `❌ ${msg}`, "fail")
        return
      }
      default:
        return
    }
  }

  // =====================================================================
  private ensureText(state: TurnState, key: string): TextBlock {
    const existing = state.texts.get(key)
    if (existing) return existing
    const block: TextBlock = { parts: new Map(), msgIDs: [], partsLen: 0, lastEdit: 0 }
    state.texts.set(key, block)
    return block
  }

  private textRaw(block: TextBlock): string {
    return [...block.parts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .filter((text) => text.length > 0)
      .join("\n\n")
  }

  private toolCallLine(name: string, input: string): string {
    const n = singleLine(name, 40)
    const i = singleLine(input, 800)
    if (!this.htmlOn()) return i ? `🔧 ${n}: ${i}` : `🔧 ${n}`
    return i ? `🔧 <code>${esc(n)}</code>: <code>${esc(i)}</code>` : `🔧 <code>${esc(n)}</code>`
  }

  /** Tool result message(s): header line + expandable blockquote with real output. */
  private toolResultParts(ok: boolean, name: string, dur: string, output: string): string[] {
    const mark = ok ? "✓" : "✗"
    const n = singleLine(name, 40)
    if (!this.htmlOn()) {
      const d = singleLine(output, 300)
      return [`${mark} ${n}${dur ? ` · ${dur}` : ""}${d ? ` · ${d}` : ""}`]
    }
    const head = `${mark} <code>${esc(n)}</code>${dur ? ` · ${dur}` : ""}`
    if (!output) return [head]
    const clipped =
      output.length > this.opts.toolOutputChars
        ? `${output.slice(0, Math.max(this.opts.toolOutputChars - 1, 1))}…`
        : output
    return splitHtml(`${head}\n<blockquote expandable>${esc(clipped)}</blockquote>`)
  }

  private outputText(content: unknown): string {
    if (!Array.isArray(content)) return ""
    return content
      .map((c) => {
        const item = c as { type?: string; text?: string }
        return item?.type === "text" ? (item.text ?? "") : ""
      })
      .filter(Boolean)
      .join("\n")
  }

  // =====================================================================
  /** Send a new message through the FIFO queue. */
  private async send(
    state: TurnState,
    text: string,
    opts: { html?: boolean; silent?: boolean; stopButton?: boolean },
  ): Promise<unknown> {
    let msg: unknown
    await this.enqueue(Number(state.chatId), () =>
      this.bot.sendMessage(Number(state.chatId), text, opts).then((m) => {
        msg = m
      }),
    )
    return msg
  }

  private async sendActivity(state: TurnState, text: string): Promise<number | undefined> {
    const m = await this.send(state, text, { html: this.htmlOn(), silent: true })
    return (m as { message_id?: number })?.message_id
  }

  private async editActivity(state: TurnState, messageID: number, text: string): Promise<void> {
    if (this.disposed) return
    try {
      await this.bot.editMessageText(Number(state.chatId), messageID, text, {
        html: this.htmlOn(),
      })
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`block edit error: ${message}`)
    }
  }

  // -------------------- reasoning streaming (chunked blockquote) --------------------
  private reasoningHtml(r: ReasoningState): string {
    if (!r.buf) return "🧠"
    return this.htmlOn()
      ? `🧠\n<blockquote expandable>${esc(r.buf)}</blockquote>`
      : `🧠\n${r.buf}`
  }

  private async maybeFlushReasoning(state: TurnState, r: ReasoningState): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    if (now - r.lastEdit >= this.opts.throttleMs) {
      await this.flushReasoning(state, r)
      return
    }
    if (!r.timer) {
      r.timer = setTimeout(() => {
        r.timer = undefined
        void this.flushReasoning(state, r).catch(() => {})
      }, this.opts.throttleMs - (now - r.lastEdit))
    }
  }

  private async flushReasoning(state: TurnState, r: ReasoningState): Promise<void> {
    if (this.disposed) return
    r.lastEdit = Date.now()
    const full = this.reasoningHtml(r)
    const parts = this.htmlOn() ? splitHtml(full) : [full.length > 4000 ? `${full.slice(0, 3999)}…` : full]
    const html = this.htmlOn()
    const grown = parts.length > r.partsLen
    try {
      // no content yet -> keep just the "🧠" line, don't touch further
      if (!r.buf && r.msgIDs.length === 1 && r.partsLen === 0) {
        r.partsLen = 1
        return
      }
      while (r.msgIDs.length < parts.length) {
        const idx = r.msgIDs.length
        const m = await this.send(state, parts[idx] ?? "", { html, silent: true })
        const id = (m as { message_id?: number })?.message_id
        if (id === undefined) break
        r.msgIDs.push(id)
      }
      if (grown || parts.length === 1) {
        for (let i = 0; i < r.msgIDs.length && i < parts.length; i++) {
          await this.editActivity(state, r.msgIDs[i] as number, parts[i] as string)
        }
      } else {
        const last = r.msgIDs.length - 1
        const id = r.msgIDs[last]
        if (id !== undefined && parts[last] !== undefined) {
          await this.editActivity(state, id, parts[last] as string)
        }
      }
      r.partsLen = parts.length
    } catch (err) {
      tlog(`reasoning flush error: ${String(err)}`)
    }
  }

  // -------------------- text block streaming --------------------
  private async maybeFlushText(state: TurnState, key: string, block: TextBlock): Promise<void> {
    if (this.disposed || block.finalized) return
    const raw = this.textRaw(block)
    if (!raw) return
    const now = Date.now()
    if (now - block.lastEdit >= this.opts.throttleMs) {
      await this.flushText(state, key, block)
      return
    }
    if (!block.timer) {
      block.timer = setTimeout(() => {
        block.timer = undefined
        void this.flushText(state, key, block).catch(() => {})
      }, this.opts.throttleMs - (now - block.lastEdit))
    }
  }

  private async flushText(state: TurnState, key: string, block: TextBlock): Promise<void> {
    if (this.disposed || !block || block.finalized) return
    if (this.opts.streaming === "drafts") {
      await this.flushDraft(state, block)
      return
    }
    block.lastEdit = Date.now()
    const raw = this.textRaw(block)
    if (!raw) return
    const html = this.htmlOn()
    const parts: string[] = html
      ? splitHtml(mdToHtml(raw))
      : [raw.length > 4000 ? `${raw.slice(0, 3999)}…` : raw]
    const grown = parts.length > block.partsLen

    try {
      while (block.msgIDs.length < parts.length) {
        const idx = block.msgIDs.length
        const m = await this.send(state, parts[idx] ?? "", { html, silent: true })
        const id = (m as { message_id?: number })?.message_id
        if (id === undefined) break
        block.msgIDs.push(id)
        state.blocks++
      }
      if (grown || parts.length === 1) {
        for (let i = 0; i < block.msgIDs.length && i < parts.length; i++) {
          await this.editText(state, block.msgIDs[i] as number, parts[i] as string)
        }
      } else {
        const last = block.msgIDs.length - 1
        const id = block.msgIDs[last]
        if (id !== undefined && parts[last] !== undefined) {
          await this.editText(state, id, parts[last] as string)
        }
      }
      block.partsLen = parts.length
    } catch (err) {
      tlog(`text flush error: ${String(err)}`)
    }
  }

  private async editText(state: TurnState, messageID: number, text: string): Promise<void> {
    if (this.disposed) return
    try {
      await this.bot.editMessageText(Number(state.chatId), messageID, text, {
        html: this.htmlOn(),
      })
    } catch (err) {
      const message = String(err)
      if (!message.includes("message is not modified")) tlog(`text edit error: ${message}`)
    }
  }

  // -------------------- drafts mode --------------------
  private async flushDraft(state: TurnState, block: TextBlock): Promise<void> {
    if (state.draftID === undefined) return
    block.lastEdit = Date.now()
    const raw = this.textRaw(block)
    if (!raw) return
    const html = this.htmlOn()
    // first split part is guaranteed well-formed (tags closed) for HTML mode
    const preview = html ? (splitHtml(mdToHtml(raw))[0] ?? "") : raw.slice(0, 4096)
    await this.bot
      .sendMessageDraft(Number(state.chatId), state.draftID, preview, {
        html,
        canStop: this.opts.stopButton,
      })
      .catch((err: unknown) => tlog(`draft error: ${String(err)}`))
  }

  /** Land a drafted text block as real, frozen message(s). */
  private async finalizeTextBlock(state: TurnState, block: TextBlock): Promise<void> {
    if (block.finalized) return
    block.finalized = true
    if (block.timer) {
      clearTimeout(block.timer)
      block.timer = undefined
    }
    const raw = this.textRaw(block)
    if (!raw) return
    const html = this.htmlOn()
    const parts = html
      ? splitHtml(mdToHtml(raw))
      : [raw.length > 4000 ? `${raw.slice(0, 3999)}…` : raw]
    for (const part of parts) {
      await this.send(state, part, { html, silent: true })
    }
    state.blocks++
  }

  private async closeOpenTexts(state: TurnState, exceptKey?: string): Promise<void> {
    if (this.opts.streaming !== "drafts") return
    for (const [key, block] of state.texts.entries()) {
      if (key === exceptKey || block.finalized) continue
      await this.finalizeTextBlock(state, block)
    }
  }

  // -------------------- terminal --------------------
  /** Remember the user's prompt message so the outcome can be reacted onto it. */
  notePromptMessage(chatId: number, messageID: number): void {
    this.lastPrompt.set(String(chatId), messageID)
  }

  private async finish(
    state: TurnState,
    marker: string | undefined,
    outcome: "ok" | "fail" | "interrupt",
  ): Promise<void> {
    if (state.finalized) return
    state.finalized = true
    if (state.typingTimer) {
      clearInterval(state.typingTimer)
      state.typingTimer = undefined
    }

    // close/finalize text blocks
    if (this.opts.streaming === "drafts") {
      await this.closeOpenTexts(state)
    } else {
      for (const [key, block] of state.texts.entries()) {
        if (block.timer) {
          clearTimeout(block.timer)
          block.timer = undefined
        }
        await this.flushText(state, key, block)
      }
    }

    // status widget: deleted, never morphed
    if (state.placeholderID !== undefined) {
      await this.enqueue(Number(state.chatId), () =>
        this.bot.deleteMessage(Number(state.chatId), state.placeholderID as number).catch(() => {}),
      )
    }

    // markers are their own messages
    if (marker) {
      await this.send(state, marker, { silent: marker.startsWith("⏹") })
    } else if (state.blocks === 0) {
      await this.send(state, "✅", { silent: false })
    }

    // images referenced in the final answer
    if (outcome === "ok") {
      await this.sendDetectedImages(state)
    }

    // outcome reaction on the user's prompt message
    const promptID = this.lastPrompt.get(state.chatId)
    if (promptID !== undefined && outcome !== "interrupt") {
      void this.bot
        .setMessageReaction(Number(state.chatId), promptID, outcome === "ok" ? "✅" : "❌")
        .catch(() => {})
    }
  }

  /** Send local images referenced in the final text as photo messages. */
  private async sendDetectedImages(state: TurnState): Promise<void> {
    if (!this.opts.autoImages) return
    const raw = [...state.texts.values()].map((b) => this.textRaw(b)).join("\n")
    if (!raw) return
    const re = /(?:^|[\s`'"(])((?:~\/|\/)[\w@./-]+\.(?:png|jpe?g|gif|webp))(?=$|[\s`'")])/gim
    const seen = new Set<string>()
    let sent = 0
    for (const m of raw.matchAll(re)) {
      if (sent >= 5) break
      const p = (m[1] as string).replace(/^~/, process.env.HOME ?? "~")
      if (seen.has(p)) continue
      seen.add(p)
      try {
        const st = await stat(p)
        if (!st.isFile() || st.size > 10 * 1024 * 1024) continue
      } catch {
        continue
      }
      sent++
      await this.enqueue(Number(state.chatId), () =>
        this.bot
          .sendPhoto(Number(state.chatId), p)
          .catch((err: unknown) => tlog(`sendPhoto failed: ${String(err)}`)),
      )
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

// -------------------- types --------------------
interface ToolCall {
  name: string
  callMsgID?: number
  resultSent?: boolean
  t0?: number
}

interface ReasoningState {
  /** chunk message ids (long thoughts split at 4096 with tags closed at seams) */
  msgIDs: number[]
  partsLen: number
  buf: string
  lastEdit: number
  timer?: ReturnType<typeof setTimeout>
}

/** One Telegram message (chunked if >4096) per assistant-message text block. */
interface TextBlock {
  /** ordinal -> raw markdown (authoritative text.ended replaces deltas) */
  parts: Map<number, string>
  msgIDs: number[]
  partsLen: number
  lastEdit: number
  timer?: ReturnType<typeof setTimeout>
  /** drafts mode: block already landed as real message(s) */
  finalized?: boolean
}

interface TurnState {
  chatId: string
  placeholderID?: number
  /** drafts mode: animated preview id (same id per turn) */
  draftID?: number
  reasoning: Map<string, ReasoningState>
  tools: Map<string, ToolCall>
  texts: Map<string, TextBlock>
  activityCount: number
  /** total content blocks sent this turn (marker/empty-turn logic) */
  blocks: number
  typingTimer?: ReturnType<typeof setInterval>
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
