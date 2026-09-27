import type { Plugin } from "@opencode/plugin"
import type { Session } from "@opencode/schema/session"
import { tlog } from "./log.js"

type Context = Plugin.Context
type Delivery = "steer" | "queue"

/**
 * Chat <-> session mapping, persisted in plugin storage.
 *   chats              -> [chatId, ...] every chat this bot ever served
 *   map:chat:<chatId>  -> sessionID (the chat's CURRENT session)
 *
 * Render scope rule: an event is rendered to a chat only when it belongs to
 * the session that chat CURRENTLY points at. Sessions are never permanently
 * glued to a chat — switching (picker, /new) instantly re-scopes rendering,
 * and foreign sessions (TUI work, other processes) never leak into Telegram.
 */
export class Sessions {
  /** chatId -> sessionID | null (null = looked up, nothing valid there) */
  private readonly currentCache = new Map<string, string | null>()
  private chats: string[] | null = null

  constructor(
    private readonly ctx: Context,
    private readonly delivery: Delivery,
    private readonly defaultModel?: { providerID: string; id: string; variant?: string },
  ) {}

  // ---- chat registry ----
  private async chatList(): Promise<string[]> {
    if (this.chats) return this.chats
    this.chats = ((await this.ctx.storage.get("chats")) as string[] | undefined) ?? []
    return this.chats
  }

  private async registerChat(chatId: number): Promise<void> {
    const list = await this.chatList()
    const id = String(chatId)
    if (list.includes(id)) return
    list.push(id)
    this.chats = list
    await this.ctx.storage.set("chats", list)
    tlog(`chat ${id} registered (${list.length} total)`)
  }

  /** All chats this bot ever served (for proactive scheduler sends). */
  async allChats(): Promise<string[]> {
    return [...(await this.chatList())]
  }

  /** The chat whose CURRENT session is `sessionID` — or undefined. */
  async chatFor(sessionID: string): Promise<string | undefined> {
    for (const id of await this.chatList()) {
      if ((await this.current(Number(id))) === sessionID) return id
    }
    return undefined
  }

  async current(chatId: number): Promise<string | undefined> {
    const key = String(chatId)
    if (this.currentCache.has(key)) return this.currentCache.get(key) ?? undefined
    const sid = ((await this.ctx.storage.get(`map:chat:${key}`)) as string | undefined) ?? null
    if (!sid) {
      this.currentCache.set(key, null)
      return undefined
    }
    try {
      await this.ctx.session.get({ sessionID: sid })
      this.currentCache.set(key, sid)
      return sid
    } catch {
      tlog(`stored session ${sid} gone — dropping mapping`)
      await this.ctx.storage.remove(`map:chat:${key}`)
      this.currentCache.set(key, null)
      return undefined
    }
  }

  async create(chatId: number): Promise<string> {
    const info = await this.ctx.session.create({
      title: "telegram",
      ...(this.defaultModel ? { model: this.defaultModel } : {}),
    })
    const sid = info.id
    await this.ctx.storage.set(`map:chat:${chatId}`, sid)
    this.currentCache.set(String(chatId), sid)
    await this.registerChat(chatId)
    tlog(`created session ${sid} for chat ${chatId}`)
    return sid
  }

  /** Ensure the chat has a live session; returns it, creating if needed. */
  async ensure(chatId: number): Promise<string> {
    return (await this.current(chatId)) ?? (await this.create(chatId))
  }

  /** Switch the chat's active session (session picker). */
  async setCurrent(chatId: number, sessionID: string): Promise<void> {
    await this.ctx.storage.set(`map:chat:${chatId}`, sessionID)
    this.currentCache.set(String(chatId), sessionID)
    await this.registerChat(chatId)
  }

  /** Route user text into the session (delivery controls busy behavior). */
  async prompt(
    chatId: number,
    text: string,
    files?: Array<{ uri: string; name?: string }>,
  ): Promise<string> {
    const sessionID = await this.ensure(chatId)
    await this.ctx.session.prompt({
      sessionID,
      text,
      delivery: this.delivery,
      ...(files && files.length > 0 ? { files } : {}),
    })
    return sessionID
  }

  // ---- permission request routing (in-memory; requests are short-lived) ----
  private readonly requests = new Map<string, string>()

  rememberRequest(requestID: string, sessionID: string): void {
    this.requests.set(requestID, sessionID)
  }

  sessionForRequest(requestID: string): string | undefined {
    return this.requests.get(requestID)
  }

  forgetRequest(requestID: string): void {
    this.requests.delete(requestID)
  }
}

export type { Session }
