import { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { tlog } from "./log.js"
import { acquireLease, runPollLoop, type Lease } from "./loop.js"
import { TelegramBot, type TelegramConfig, type TelegramMessage } from "./bot.js"
import { Sessions } from "./sessions.js"
import { Renderer } from "./render.js"
import { dispatch, type UndoStashEntry } from "./commands.js"
import { buildRegistry, syncMenu } from "./builtins.js"
import { apiCall, configureLocalApi } from "./local-api.js"

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
    const activityOn = ctx.options.activity !== "off"
    const showReasoning = ctx.options.showReasoning !== false
    const maxActivity =
      typeof ctx.options.maxActivityMessages === "number" ? ctx.options.maxActivityMessages : 60
    const formatting: "html" | "plain" = ctx.options.formatting === "plain" ? "plain" : "html"
    const typingOn = ctx.options.typing !== false
    const stopButtonOn = ctx.options.stopButton !== false
    const toolOutputChars =
      typeof ctx.options.toolOutputChars === "number" ? ctx.options.toolOutputChars : 3000
    const autoImages = ctx.options.autoImages !== false
    const streaming: "drafts" | "edits" = ctx.options.streaming === "edits" ? "edits" : "drafts"

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
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let scheduleRegistryRefresh: (() => void) | undefined

    if (!token) {
      tlog("no token configured — Telegram idle (set options.token or TELEGRAM_BOT_TOKEN)")
    } else {
      lease = acquireLease()
      if (!lease.held) {
        tlog("loop owned by another opencode process (pid lease busy) — standing down")
        lease = undefined
      } else {
        renderer = new Renderer(bot as TelegramBot, sessions, {
          throttleMs,
          activity: activityOn,
          showReasoning,
          maxActivityMessages: maxActivity,
          formatting,
          typing: typingOn,
          stopButton: stopButtonOn,
          toolOutputChars,
          autoImages,
          streaming,
        })
        tlog(
          `telegram holder active (offset=${lease.offset}, delivery=${delivery}, ` +
            `activity=${activityOn ? "per-action" : "off"}, reasoning=${showReasoning}, ` +
            `formatting=${formatting}, allowFrom=${JSON.stringify(allowFrom)})`,
        )

        // local API override + command registry + menu sync
        configureLocalApi(
          ctx.options.localApi as { port?: number; password?: string } | undefined,
        )
        const cmdOpts = (ctx.options.commands ?? {}) as {
          builtins?: boolean
          custom?: boolean
          hidden?: string[]
        }
        const registryOpts = {
          builtins: cmdOpts.builtins !== false,
          custom: cmdOpts.custom !== false,
          hidden: Array.isArray(cmdOpts.hidden) ? cmdOpts.hidden.map(String) : [],
        }
        let registry = await buildRegistry(ctx, registryOpts)
        void syncMenu(bot as TelegramBot, registry).catch((err) =>
          tlog(`menu sync failed: ${String(err)}`),
        )
        scheduleRegistryRefresh = () => {
          if (refreshTimer) return
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            void buildRegistry(ctx, registryOpts)
              .then((r) => {
                registry = r
                return syncMenu(bot as TelegramBot, r)
              })
              .catch((err) => tlog(`registry refresh failed: ${String(err)}`))
          }, 2000)
        }
        const undoStash = new Map<string, UndoStashEntry>()

        void bot
          ?.setMyDescription("OpenCode on Telegram — drive a local OpenCode agent from a DM.")
          .catch(() => {})
        void bot?.setMyShortDescription("OpenCode bridge").catch(() => {})

        const onMessage = async (msg: TelegramMessage): Promise<void> => {
          try {
            const photo =
              msg.photo && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1] : undefined
            const doc =
              msg.document && msg.document.mime_type?.startsWith("image/") ? msg.document : undefined
            const fileID = photo?.file_id ?? doc?.file_id
            if (fileID) {
              const meta = await (bot as TelegramBot).getFile(fileID)
              const ext = meta.file_path.includes(".")
                ? meta.file_path.slice(meta.file_path.lastIndexOf("."))
                : ".jpg"
              const dest = join(
                homedir(),
                ".cache",
                "opencode-telegram",
                "uploads",
                `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
              )
              await (bot as TelegramBot).downloadFile(meta.file_path, dest)
              const caption = msg.caption ?? "Look at this image"
              renderer?.notePromptMessage(msg.chat.id, msg.message_id)
              const sid = await sessions.prompt(msg.chat.id, caption, [
                { uri: `file://${dest}`, name: basename(dest) },
              ])
              tlog(`prompt (image) → session ${sid}`)
              return
            }
            if (msg.document) {
              await bot?.sendMessage(msg.chat.id, "only images are supported for now")
              return
            }
            const text = msg.text ?? ""
            if (text.startsWith("/")) {
              await dispatch({
                ctx,
                bot: bot as TelegramBot,
                chatId: msg.chat.id,
                text,
                sessions,
                registry,
                undoStash,
              })
            } else {
              renderer?.notePromptMessage(msg.chat.id, msg.message_id)
              const sid = await sessions.prompt(msg.chat.id, text)
              tlog(`prompt → session ${sid}`)
            }
          } catch (err) {
            tlog(`onMessage error: ${String(err)}`)
            await bot?.sendMessage(msg.chat.id, `⚠️ ${String(err)}`).catch(() => {})
          }
        }

        const onCallback = async (cb: {
          callbackID: string
          chatId: number
          data: string
          messageID?: number
          cardText?: string
        }): Promise<void> => {
          try {
            if (cb.data === "undo:confirm" || cb.data === "undo:cancel") {
              const stash = undoStash.get(String(cb.chatId))
              if (!stash) {
                await bot?.answerCallbackQuery(cb.callbackID, "expired")
                return
              }
              try {
                if (cb.data === "undo:confirm") {
                  await apiCall("POST", `/api/session/${stash.sessionID}/revert/commit`)
                  await bot?.answerCallbackQuery(cb.callbackID, "✅ undone")
                } else {
                  await apiCall("DELETE", `/api/session/${stash.sessionID}/revert`)
                  await bot?.answerCallbackQuery(cb.callbackID, "cancelled")
                }
                undoStash.delete(String(cb.chatId))
                if (cb.messageID !== undefined) {
                  const card = cb.cardText ?? "undo"
                  const mark = cb.data === "undo:confirm" ? "✅ undone" : "🚫 cancelled"
                  await bot
                    ?.editMessageText(cb.chatId, cb.messageID, `${card}\n\n${mark}`, {
                      html: true,
                      removeKeyboard: true,
                    })
                    .catch(() => {})
                }
              } catch (err) {
                tlog(`undo callback failed: ${String(err)}`)
                await bot?.answerCallbackQuery(cb.callbackID, "failed")
              }
              return
            }
            if (cb.data.startsWith("sess:")) {
              const target = cb.data.slice(5)
              try {
                const info = await ctx.session.get({ sessionID: target })
                await sessions.setCurrent(cb.chatId, target)
                await bot?.answerCallbackQuery(cb.callbackID, "switched")
                if (cb.messageID !== undefined) {
                  await bot
                    ?.editMessageText(
                      cb.chatId,
                      cb.messageID,
                      `🗂 session: ${info.title ?? target}\n${target}`,
                      { removeKeyboard: true },
                    )
                    .catch(() => {})
                }
              } catch {
                await bot?.answerCallbackQuery(cb.callbackID, "session not found")
              }
              return
            }
            if (cb.data.startsWith("perm:")) {
              const parts = cb.data.split(":")
              const reply = parts[1]
              const requestID = parts.slice(2).join(":")
              if (!requestID || !["once", "always", "reject"].includes(reply ?? "")) {
                await bot?.answerCallbackQuery(cb.callbackID, "expired")
                return
              }
              const sid = sessions.sessionForRequest(requestID)
              if (!sid) {
                await bot?.answerCallbackQuery(cb.callbackID, "expired — reply from the app instead")
                return
              }
              await ctx.permission.reply({
                sessionID: sid,
                requestID,
                decision: reply as "once" | "always" | "reject",
              })
              sessions.forgetRequest(requestID)
              const mark =
                reply === "reject" ? "🚫 rejected" : reply === "always" ? "♾️ allowed (always)" : "✅ allowed (once)"
              await bot?.answerCallbackQuery(cb.callbackID, mark)
              if (cb.messageID !== undefined) {
                const card = cb.cardText ?? "permission"
                await bot
                  ?.editMessageText(cb.chatId, cb.messageID, `${card}\n\n${mark}`, {
                    html: true,
                    removeKeyboard: true,
                  })
                  .catch(() => {})
              }
              return
            }
            if (cb.data === "stop") {
              const sid = await sessions.current(cb.chatId)
              if (!sid) {
                await bot?.answerCallbackQuery(cb.callbackID, "no active session")
                return
              }
              await bot?.answerCallbackQuery(cb.callbackID, "⏹ stopping…")
              await ctx.session.interrupt({ sessionID: sid })
              tlog(`stop via button (session ${sid})`)
            } else {
              await bot?.answerCallbackQuery(cb.callbackID)
            }
          } catch (err) {
            tlog(`callback error: ${String(err)}`)
            await bot?.answerCallbackQuery(cb.callbackID).catch(() => {})
          }
        }

        const onStopped = async (s: { chatId: number; draftID: number }): Promise<void> => {
          try {
            const sid = await sessions.current(s.chatId)
            if (!sid) return
            await ctx.session.interrupt({ sessionID: sid })
            tlog(`stop via draft button (session ${sid})`)
          } catch (err) {
            tlog(`onStopped error: ${String(err)}`)
          }
        }

        void runPollLoop({
          bot: bot as TelegramBot,
          cfg,
          lease,
          signal: ac.signal,
          onMessage,
          onCallback,
          onStopped,
        }).catch((err) => tlog(`poll loop crashed: ${String(err)}`))
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
            if (event.type === "command.updated" && scheduleRegistryRefresh) {
              scheduleRegistryRefresh()
            }
          }
        }
      } catch (err) {
        tlog(`event stream ended: ${String(err)}`)
      }
    })()

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      renderer?.dispose()
      lease?.release()
      ac.abort()
      tlog(`cleanup after ${total} events (${seen.size} unique types)`)
    }
  },
})
