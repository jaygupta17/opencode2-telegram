import { Plugin } from "@opencode/plugin"
import { tlog } from "./log.js"
import { acquireLease, runPollLoop, type Lease } from "./loop.js"
import { TelegramBot, type TelegramConfig, type TelegramMessage } from "./bot.js"
import { Sessions } from "./sessions.js"
import { Renderer } from "./render.js"
import { dispatch } from "./commands.js"

/**
 * opencode-telegram — drive OpenCode from a Telegram DM.
 *
 * Phase 3: text -> real OpenCode sessions (queue delivery), streamed
 * assistant output edited in place, /new /status /stop /compact /agent
 * /model /history commands. The lease holder owns BOTH the poll loop and
 * the outbound renderer so multiple opencode processes never double-send.
 */
export default Plugin.define({
  id: "opencode-telegram",
  async setup(ctx) {
    tlog(`setup app=${ctx.app.version} channel=${ctx.app.channel} dir=${ctx.location.directory} options=${JSON.stringify(ctx.options)}`)

    const loads = ((await ctx.storage.get("loads")) as number | undefined) ?? 0
    await ctx.storage.set("loads", loads + 1)
    await ctx.storage.set("last-load", { at: new Date().toISOString(), version: ctx.app.version })
    tlog(`storage ok — load #${loads + 1}`)

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
    const delivery: "steer" | "queue" = ctx.options.delivery === "steer" ? "steer" : "queue"
    const throttleMs = typeof ctx.options.throttleMs === "number" ? ctx.options.throttleMs : 1500

    // default model for NEW sessions (else opencode's default — may be plan-gated)
    const modelOpt = typeof ctx.options.model === "string" ? ctx.options.model : ""
    let defaultModel: { providerID: string; id: string } | undefined
    const slash = modelOpt.indexOf("/")
    if (slash > 0) {
      defaultModel = { providerID: modelOpt.slice(0, slash), id: modelOpt.slice(slash + 1) }
      tlog(`default model for new sessions: ${modelOpt}`)
    }

    const ac = new AbortController()
    const sessions = new Sessions(ctx, delivery, defaultModel)
    const bot = token ? new TelegramBot(cfg) : undefined

    let lease: Lease | undefined
    let renderer: Renderer | undefined

    if (!token) {
      tlog("no token configured — Telegram idle (set options.token or TELEGRAM_BOT_TOKEN)")
    } else {
      lease = acquireLease()
      if (!lease.held) {
        tlog("loop owned by another opencode process (pid lease busy) — standing down")
        lease = undefined
      } else {
        renderer = new Renderer(bot as TelegramBot, sessions, throttleMs)
        tlog(`telegram holder active (offset=${lease.offset}, delivery=${delivery}, allowFrom=${JSON.stringify(allowFrom)})`)

        const onMessage = async (msg: TelegramMessage): Promise<void> => {
          try {
            const text = msg.text ?? ""
            if (text.startsWith("/")) {
              await dispatch({ ctx, bot: bot as TelegramBot, chatId: msg.chat.id, text, sessions })
            } else {
              const sid = await sessions.prompt(msg.chat.id, text)
              tlog(`prompt → session ${sid}`)
            }
          } catch (err) {
            tlog(`onMessage error: ${String(err)}`)
            await bot?.sendMessage(msg.chat.id, `⚠️ ${String(err)}`).catch(() => {})
          }
        }

        void runPollLoop({ bot: bot as TelegramBot, cfg, lease, signal: ac.signal, onMessage }).catch((err) =>
          tlog(`poll loop crashed: ${String(err)}`),
        )
      }
    }

    // one subscription feeds both the harness census and the renderer
    const seen = new Set<string>()
    let total = 0
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: ac.signal })) {
          total++
          if (!seen.has(event.type)) {
            seen.add(event.type)
            tlog(`event-type #${seen.size}: ${event.type}`)
          }
          if (renderer) {
            try {
              await renderer.handle(event)
            } catch (err) {
              tlog(`render error: ${String(err)}`)
            }
          }
        }
      } catch (err) {
        tlog(`event stream ended: ${String(err)}`)
      }
    })()

    return () => {
      renderer?.dispose()
      lease?.release()
      ac.abort()
      tlog(`cleanup after ${total} events (${seen.size} unique types)`)
    }
  },
})
