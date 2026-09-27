import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { TelegramBot, type TelegramConfig, type TelegramMessage, type TelegramUpdate } from "./bot.js"
import { tlog } from "./log.js"

/**
 * Single-instance lease. Multiple opencode processes (serve, the TUI's
 * background service, worktree locations) may all activate this plugin —
 * exactly one may run the getUpdates loop. A pid+heartbeat file under
 * ~/.cache decides ownership; a dead pid or stale heartbeat loses it.
 * The Telegram poll offset lives IN the lease file so any future holder
 * resumes exactly where the last one stopped.
 */
const LEASE_DIR = join(homedir(), ".cache", "opencode-telegram")
const LEASE_FILE = join(LEASE_DIR, "loop.lease")
const HEARTBEAT_MS = 10_000
const STALE_MS = 45_000

interface LeaseData {
  pid: number
  at: number
  offset: number
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const readLease = (): LeaseData | undefined => {
  try {
    return JSON.parse(readFileSync(LEASE_FILE, "utf8")) as LeaseData
  } catch {
    return undefined
  }
}

const writeLease = (data: LeaseData): void => {
  writeSync(openSync(LEASE_FILE, "w"), JSON.stringify(data))
}

export interface Lease {
  held: boolean
  offset: number
  setOffset: (offset: number) => void
  /** persist offset outside the lease file (plugin storage) — survives reloads */
  setPersister: (fn: (offset: number) => void) => void
  release: () => void
}

export function acquireLease(initialOffset = 0): Lease {
  mkdirSync(LEASE_DIR, { recursive: true })
  const me = process.pid
  let offset = initialOffset
  let persister: ((offset: number) => void) | undefined

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(LEASE_FILE, "wx")
      writeSync(fd, JSON.stringify({ pid: me, at: Date.now(), offset } satisfies LeaseData))
      closeSync(fd)
      return makeHeld()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      const prev = readLease()
      if (prev && pidAlive(prev.pid) && Date.now() - prev.at < STALE_MS) {
        return {
          held: false,
          offset: prev.offset,
          setOffset: () => {},
          setPersister: () => {},
          release: () => {},
        }
      }
      // dead pid or stale heartbeat (or unreadable) — steal it
      offset = Math.max(prev?.offset ?? 0, initialOffset)
      try {
        unlinkSync(LEASE_FILE)
      } catch {
        /* already gone */
      }
    }
  }
  return {
    held: false,
    offset: 0,
    setOffset: () => {},
    setPersister: () => {},
    release: () => {},
  }

  function makeHeld(): Lease {
    let offsetNow = offset
    const beat = setInterval(() => {
      try {
        writeLease({ pid: me, at: Date.now(), offset: offsetNow })
      } catch {
        /* best effort */
      }
    }, HEARTBEAT_MS)
    beat.unref?.()
    const leaseObj: Lease = {
      held: true,
      get offset() {
        return offsetNow
      },
      setOffset(next: number) {
        offsetNow = next
        try {
          writeLease({ pid: me, at: Date.now(), offset: next })
        } catch {
          /* best effort */
        }
        try {
          persister?.(next)
        } catch {
          /* best effort */
        }
      },
      setPersister(fn: (offset: number) => void) {
        persister = fn
      },
      release() {
        clearInterval(beat)
        try {
          const cur = readLease()
          if (cur?.pid === me) unlinkSync(LEASE_FILE)
        } catch {
          /* best effort */
        }
      },
    }
    return leaseObj
  }
}

/**
 * Ownership re-check for a RUNNING poll loop: another live process took the
 * lease (hot-reload, newer TUI) -> we must stop polling or Telegram 409s.
 */
export function leaseOwnership(): "mine" | "other" | "free" {
  const cur = readLease()
  if (!cur) return "free"
  if (cur.pid === process.pid) return "mine"
  return pidAlive(cur.pid) ? "other" : "free"
}

/** Re-assert a free lease file (previous holder died while we were polling). */
export function reassertLease(offset: number): void {
  try {
    writeLease({ pid: process.pid, at: Date.now(), offset })
  } catch {
    /* best effort */
  }
}

/** DM-only gate → allowlist/bootstrap → hand off to handlers. */
async function route(
  bot: TelegramBot,
  cfg: TelegramConfig,
  update: TelegramUpdate,
  handlers: {
    onMessage: (msg: TelegramMessage) => Promise<void>
    onCallback: (cb: {
      callbackID: string
      chatId: number
      data: string
      messageID?: number
      cardText?: string
    }) => Promise<void>
    onStopped: (s: { chatId: number; draftID: number }) => Promise<void>
  },
): Promise<void> {
  const stopped = update.stopped_message_generation
  if (stopped) {
    const chatId = String(stopped.chat.id)
    if (!cfg.allowFrom.includes(chatId)) return
    await handlers.onStopped({ chatId: Number(chatId), draftID: stopped.draft_id })
    return
  }
  const cb = update.callback_query
  if (cb) {
    const chatId = String(cb.message?.chat?.id ?? cb.from.id)
    if (!cfg.allowFrom.includes(chatId)) {
      tlog(`ignored callback from ${chatId}`)
      await bot.answerCallbackQuery(cb.id).catch(() => {})
      return
    }
    await handlers.onCallback({
      callbackID: cb.id,
      chatId: Number(chatId),
      data: cb.data ?? "",
      messageID: cb.message?.message_id,
      cardText: cb.message?.text,
    })
    return
  }
  const msg = update.message
  if (!msg) return
  if (msg.chat.type !== "private") {
    tlog(`ignored non-DM from chat ${msg.chat.id} (DM-only)`)
    return
  }
  const chatId = String(msg.chat.id)
  const allowed = cfg.allowFrom.includes(chatId)
  if (!allowed && cfg.allowFrom.length > 0) {
    tlog(`ignored stranger ${chatId}`)
    return
  }
  if (!allowed) {
    // bootstrap mode: tell the user their chat id so they can allowlist it
    tlog(`bootstrap reply to ${chatId}`)
    await bot.sendMessage(msg.chat.id, `chat_id: ${chatId}\n\nAdd it to options.allowFrom in opencode.json to lock the bot to your account.`)
    return
  }
  if (!msg.text && !(msg.photo && msg.photo.length > 0) && !msg.document) {
    await bot.sendMessage(msg.chat.id, "unsupported message type").catch(() => {})
    return
  }
  await handlers.onMessage(msg)
}

export async function runPollLoop(opts: {
  bot: TelegramBot
  cfg: TelegramConfig
  lease: Lease
  signal: AbortSignal
  onMessage: (msg: TelegramMessage) => Promise<void>
  onCallback: (cb: {
    callbackID: string
    chatId: number
    data: string
    messageID?: number
    cardText?: string
  }) => Promise<void>
  onStopped: (s: { chatId: number; draftID: number }) => Promise<void>
}): Promise<void> {
  const { bot, cfg, lease, signal, onMessage, onCallback, onStopped } = opts
  let backoffMs = 2_000
  let offset = lease.offset
  let lastOwnedCheck = 0

  while (!signal.aborted) {
    // yield if another live process took the lease (hot-reload / newer TUI)
    if (Date.now() - lastOwnedCheck > 15_000) {
      lastOwnedCheck = Date.now()
      const owned = leaseOwnership()
      if (owned === "other") {
        tlog("lease taken by another live process — standing down")
        lease.release()
        return
      }
      if (owned === "free") reassertLease(offset)
    }
    try {
      const updates = await bot.getUpdates(offset, signal)
      backoffMs = 2_000
      for (const update of updates) {
        offset = update.update_id + 1
        lease.setOffset(offset)
        try {
          await route(bot, cfg, update, { onMessage, onCallback, onStopped })
        } catch (err) {
          tlog(`route error: ${String(err)}`)
        }
      }
    } catch (err) {
      if (signal.aborted) break
      const message = String(err)
      // 409 = another getUpdates poller — re-check ownership right away
      if (message.includes("Conflict")) {
        if (leaseOwnership() === "other") {
          tlog("poll conflict + lease lost — standing down")
          lease.release()
          return
        }
      }
      tlog(`poll error (retry in ${backoffMs}ms): ${message}`)
      await new Promise((resolve) => {
        const t = setTimeout(resolve, backoffMs)
        signal.addEventListener("abort", () => clearTimeout(t), { once: true })
      })
      backoffMs = Math.min(backoffMs * 2, 60_000)
    }
  }
  tlog("poll loop exited")
}

export const leaseFileExists = (): boolean => existsSync(LEASE_FILE)
