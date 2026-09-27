import type { Plugin } from "@opencode/plugin"
import type { Session } from "@opencode/schema/session"
import { tlog } from "./log.js"

type Context = Plugin.Context
type Delivery = "steer" | "queue"

/**
 * Chat <-> session mapping, persisted in plugin storage.
 *   map:chat:<chatId>  -> sessionID
 *   map:session:<sid>  -> chatId   (renderer's event -> chat lookup)
 * An in-memory cache avoids a storage read per streamed delta; entries are
 * written on mapping creation, so every unmapped session is cached as null
 * after its first event.
 */
export class Sessions {
  private readonly cache = new Map<string, string | null>()
  /** pending permission request id -> session id (callback routing) */
  private readonly requests = new Map<string, string>()

  constructor(
    private readonly ctx: Context,
    private readonly delivery: Delivery,
    private readonly defaultModel?: { providerID: string; id: string },
  ) {}

  async chatFor(sessionID: string): Promise<string | undefined> {
    if (this.cache.has(sessionID)) return this.cache.get(sessionID) ?? undefined
    const chatId = ((await this.ctx.storage.get(`map:session:${sessionID}`)) as string | undefined) ?? null
    this.cache.set(sessionID, chatId)
    return chatId ?? undefined
  }

  remember(sessionID: string, chatId: string): void {
    this.cache.set(sessionID, chatId)
  }

  async current(chatId: number): Promise<string | undefined> {
    const sid = (await this.ctx.storage.get(`map:chat:${chatId}`)) as string | undefined
    if (!sid) return undefined
    try {
      await this.ctx.session.get({ sessionID: sid })
      return sid
    } catch {
      tlog(`stored session ${sid} gone — dropping mapping`)
      await this.ctx.storage.remove(`map:chat:${chatId}`)
      await this.ctx.storage.remove(`map:session:${sid}`)
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
    await this.ctx.storage.set(`map:session:${sid}`, String(chatId))
    this.remember(sid, String(chatId))
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
    await this.ctx.storage.set(`map:session:${sessionID}`, String(chatId))
    this.remember(sessionID, String(chatId))
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

  // ---- permission request routing ----
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
