import { Plugin } from "@opencode/plugin"
import { tlog } from "./log.js"
import { acquireLease, runPollLoop, type Lease } from "./loop.js"
import type { TelegramConfig } from "./bot.js"

/**
 * opencode-telegram — drive OpenCode from a Telegram DM.
 *
 * Phase 2: long-poll getUpdates loop (single-instance lease), DM-only +
 * chat-id allowlist gate, bootstrap chat-id capture, echo roundtrip.
 */
export default Plugin.define({
  id: "opencode-telegram",
  async setup(ctx) {
    tlog(`setup app=${ctx.app.version} channel=${ctx.app.channel} dir=${ctx.location.directory} options=${JSON.stringify(ctx.options)}`)

    const loads = ((await ctx.storage.get("loads")) as number | undefined) ?? 0
    await ctx.storage.set("loads", loads + 1)
    await ctx.storage.set("last-load", { at: new Date().toISOString(), version: ctx.app.version })
    tlog(`storage ok — load #${loads + 1}`)

    // event census (harness asserts at least one event-type line)
    const ac = { ctrl: new AbortController() }
    const seen = new Set<string>()
    let total = 0
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: ac.ctrl.signal })) {
          total++
          if (!seen.has(event.type)) {
            seen.add(event.type)
            tlog(`event-type #${seen.size}: ${event.type}`)
          }
        }
      } catch (err) {
        tlog(`event stream ended: ${String(err)}`)
      }
    })()

    // Telegram config: options win, env preferred for published installs
    const token =
      (typeof ctx.options.token === "string" && ctx.options.token) ||
      process.env.TELEGRAM_BOT_TOKEN ||
      ""
    const allowFrom = Array.isArray(ctx.options.allowFrom)
      ? (ctx.options.allowFrom as unknown[]).map(String)
      : []
    const cfg: TelegramConfig = {
      token,
      allowFrom,
      pollTimeoutSec: typeof ctx.options.pollTimeoutSec === "number" ? ctx.options.pollTimeoutSec : 30,
    }

    let lease: Lease | undefined
    if (!token) {
      tlog("no token configured — Telegram loop idle (set options.token or TELEGRAM_BOT_TOKEN)")
    } else {
      lease = acquireLease()
      if (!lease.held) {
        tlog(`loop owned by another opencode process (pid lease busy) — standing down`)
        lease = undefined
      } else {
        tlog(`poll loop starting (offset=${lease.offset}, allowFrom=${JSON.stringify(allowFrom)})`)
        void runPollLoop({ cfg, lease, signal: ac.ctrl.signal }).catch((err) =>
          tlog(`poll loop crashed: ${String(err)}`),
        )
      }
    }

    return () => {
      lease?.release()
      ac.ctrl.abort()
      tlog(`cleanup after ${total} events (${seen.size} unique types)`)
    }
  },
})
