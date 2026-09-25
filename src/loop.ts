import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { TelegramBot, type TelegramConfig, type TelegramUpdate } from "./bot.js"
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
  release: () => void
}

export function acquireLease(): Lease {
  mkdirSync(LEASE_DIR, { recursive: true })
  const me = process.pid
  let offset = 0

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
        return { held: false, offset: prev.offset, setOffset: () => {}, release: () => {} }
      }
      // dead pid or stale heartbeat (or unreadable) — steal it
      offset = prev?.offset ?? 0
      try {
        unlinkSync(LEASE_FILE)
      } catch {
        /* already gone */
      }
    }
  }
  return { held: false, offset: 0, setOffset: () => {}, release: () => {} }

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
    return {
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
  }
}

/** Route one update: DM-only gate → allowlist/bootstrap → echo commands. */
async function route(bot: TelegramBot, cfg: TelegramConfig, update: TelegramUpdate): Promise<void> {
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
  const text = msg.text ?? ""
  if (text.startsWith("/")) {
    const cmd = text.slice(1).split(/[\s@]+/)[0]?.toLowerCase()
    if (cmd === "start" || cmd === "help") {
      await bot.sendMessage(msg.chat.id, "opencode-telegram is alive. Commands land in Phase 3 — echo is running for now.")
    } else {
      await bot.sendMessage(msg.chat.id, `unknown command: /${cmd}`)
    }
    return
  }
  await bot.sendMessage(msg.chat.id, `↩ ${text}`)
}

export async function runPollLoop(opts: {
  cfg: TelegramConfig
  lease: Lease
  signal: AbortSignal
}): Promise<void> {
  const { cfg, lease, signal } = opts
  const bot = new TelegramBot(cfg)
  let backoffMs = 2_000
  let offset = lease.offset

  while (!signal.aborted) {
    try {
      const updates = await bot.getUpdates(offset, signal)
      backoffMs = 2_000
      for (const update of updates) {
        offset = update.update_id + 1
        lease.setOffset(offset)
        try {
          await route(bot, cfg, update)
        } catch (err) {
          tlog(`route error: ${String(err)}`)
        }
      }
    } catch (err) {
      if (signal.aborted) break
      tlog(`poll error (retry in ${backoffMs}ms): ${String(err)}`)
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
