import { stripTags } from "./format.js"

/** Minimal zero-dependency Telegram Bot API client (fetch-based). */

export interface TelegramMessage {
  message_id: number
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  chat: { id: number; type: string }
  from?: { id: number; username?: string; first_name?: string }
}

export interface TelegramCallbackQuery {
  id: string
  from: { id: number }
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
  stopped_message_generation?: {
    chat: { id: number; type: string }
    message_thread_id?: number
    draft_id: number
  }
}

export interface TelegramConfig {
  token: string
  allowFrom: string[]
  pollTimeoutSec: number
}

export interface SendOpts {
  /** parse_mode HTML (auto-falls back to plain text on 400 parse errors) */
  html?: boolean
  /** disable_notification — no chat buzz (activity/reasoning/chunk messages) */
  silent?: boolean
  /** attach the [⏹ Stop] inline button */
  stopButton?: boolean
  /** raw reply_markup (inline keyboard) — takes precedence over stopButton */
  keyboard?: unknown
}

export interface EditOpts extends SendOpts {
  /** explicitly clear any inline keyboard */
  removeKeyboard?: boolean
}

interface ApiEnvelope<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

const STOP_BUTTON = { inline_keyboard: [[{ text: "⏹ Stop", callback_data: "stop" }]] }
const NO_BUTTON = { inline_keyboard: [] as unknown[][] }
const NO_PREVIEW = { is_disabled: true }

export class TelegramBot {
  constructor(private readonly cfg: TelegramConfig) {}

  private async call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.cfg.token}/${method}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const json = (await res.json()) as ApiEnvelope<T>
    if (!json.ok) {
      const retry = json.parameters?.retry_after
      throw new Error(
        `telegram ${method} failed: ${json.error_code} ${json.description ?? ""}${retry ? ` retry_after=${retry}` : ""}`,
      )
    }
    return json.result as T
  }

  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout: this.cfg.pollTimeoutSec,
        allowed_updates: ["message", "callback_query", "stopped_message_generation"],
      },
      signal,
    )
  }

  /** Stream a formatted preview draft (same draft_id animates; empty text = "Thinking…"). */
  sendMessageDraft(
    chatId: number,
    draftID: number,
    text: string,
    opts?: { html?: boolean; canStop?: boolean },
  ): Promise<unknown> {
    return this.call("sendMessageDraft", {
      chat_id: chatId,
      draft_id: draftID,
      text: text.slice(0, 4096),
      ...(opts?.html ? { parse_mode: "HTML" } : {}),
      ...(opts?.canStop ? { can_stop: true } : {}),
    })
  }

  private baseBody(chatId: number, text: string, opts: SendOpts): Record<string, unknown> {
    return {
      chat_id: chatId,
      text,
      ...(opts.html ? { parse_mode: "HTML" } : {}),
      ...(opts.silent ? { disable_notification: true } : {}),
      link_preview_options: NO_PREVIEW,
      ...(opts.keyboard
        ? { reply_markup: opts.keyboard }
        : opts.stopButton
          ? { reply_markup: STOP_BUTTON }
          : {}),
    }
  }

  async sendMessage(chatId: number, text: string, opts: SendOpts = {}): Promise<unknown> {
    const chunk = text.length > 4096 ? `${text.slice(0, 4093)}…` : text
    try {
      return await this.call("sendMessage", this.baseBody(chatId, chunk, opts))
    } catch (err) {
      if (opts.html && String(err).includes("parse")) {
        return await this.call(
          "sendMessage",
          this.baseBody(chatId, stripTags(chunk), { ...opts, html: false }),
        )
      }
      throw err
    }
  }

  async editMessageText(
    chatId: number,
    messageID: number,
    text: string,
    opts: EditOpts = {},
  ): Promise<unknown> {
    const chunk = text.length > 4096 ? `${text.slice(0, 4093)}…` : text
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageID,
      text: chunk,
      ...(opts.html ? { parse_mode: "HTML" } : {}),
      link_preview_options: NO_PREVIEW,
      ...(opts.removeKeyboard ? { reply_markup: NO_BUTTON } : {}),
    }
    try {
      return await this.call("editMessageText", body)
    } catch (err) {
      const message = String(err)
      if (opts.html && message.includes("parse")) {
        delete body.parse_mode
        body.text = stripTags(chunk)
        return await this.call("editMessageText", body)
      }
      throw err
    }
  }

  sendChatAction(chatId: number, action = "typing"): Promise<unknown> {
    return this.call("sendChatAction", { chat_id: chatId, action })
  }

  deleteMessage(chatId: number, messageID: number): Promise<unknown> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageID })
  }

  setMessageReaction(chatId: number, messageID: number, emoji: string): Promise<unknown> {
    return this.call("setMessageReaction", {
      chat_id: chatId,
      message_id: messageID,
      reaction: [{ type: "emoji", emoji }],
    })
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<unknown> {
    return this.call("setMyCommands", { commands })
  }

  setMyDescription(description: string): Promise<unknown> {
    return this.call("setMyDescription", { description })
  }

  setMyShortDescription(short: string): Promise<unknown> {
    return this.call("setMyShortDescription", { short_description: short })
  }

  // ---- files ----
  getFile(fileID: string): Promise<{ file_id: string; file_path: string; file_size?: number }> {
    return this.call("getFile", { file_id: fileID })
  }

  /** Download a Telegram file to a local path. Returns the path. */
  async downloadFile(filePath: string, destPath: string): Promise<string> {
    const res = await fetch(`https://api.telegram.org/file/bot${this.cfg.token}/${filePath}`)
    if (!res.ok) throw new Error(`file download failed: ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const { writeFile, mkdir } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, buf)
    return destPath
  }

  /** Upload a local image as a photo (multipart). Falls back to document on failure. */
  async sendPhoto(chatId: number, filePath: string, caption?: string): Promise<unknown> {
    const { readFile } = await import("node:fs/promises")
    const { basename } = await import("node:path")
    const bytes = await readFile(filePath)
    const form = new FormData()
    form.append("chat_id", String(chatId))
    if (caption) form.append("caption", caption.slice(0, 1000))
    form.append("photo", new Blob([new Uint8Array(bytes)]), basename(filePath))
    const res = await fetch(`https://api.telegram.org/bot${this.cfg.token}/sendPhoto`, {
      method: "POST",
      body: form,
    })
    const json = (await res.json()) as ApiEnvelope<unknown>
    if (!json.ok) {
      throw new Error(`telegram sendPhoto failed: ${json.error_code} ${json.description ?? ""}`)
    }
    return json.result
  }

  answerCallbackQuery(callbackID: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackID,
      ...(text ? { text } : {}),
    })
  }

  /** Hard cap guard used by callers before sendMessage. */
  static readonly MAX_LEN = 4096
}
