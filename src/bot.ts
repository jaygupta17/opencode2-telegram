/** Minimal zero-dependency Telegram Bot API client (fetch-based). */

export interface TelegramMessage {
  message_id: number
  text?: string
  chat: { id: number; type: string }
  from?: { id: number; username?: string; first_name?: string }
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

export interface TelegramConfig {
  token: string
  allowFrom: string[]
  pollTimeoutSec: number
}

interface ApiEnvelope<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
}

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
      throw new Error(`telegram ${method} failed: ${json.error_code} ${json.description ?? ""}`)
    }
    return json.result as T
  }

  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call(
      "getUpdates",
      { offset, timeout: this.cfg.pollTimeoutSec, allowed_updates: ["message"] },
      signal,
    )
  }

  sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<unknown> {
    // Telegram rejects >4096 chars; chunk defensively.
    const chunk = text.length > 4096 ? `${text.slice(0, 4093)}...` : text
    return this.call("sendMessage", { chat_id: chatId, text: chunk }, signal)
  }

  editMessageText(chatId: number, messageID: number, text: string, signal?: AbortSignal): Promise<unknown> {
    const chunk = text.length > 4096 ? `${text.slice(0, 4093)}...` : text
    return this.call("editMessageText", { chat_id: chatId, message_id: messageID, text: chunk }, signal)
  }
}
