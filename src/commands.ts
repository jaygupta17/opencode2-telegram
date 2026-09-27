import type { Plugin } from "@opencode/plugin"
import type { TelegramBot } from "./bot.js"
import type { Sessions } from "./sessions.js"
import type { Registry } from "./builtins.js"
import { helpText } from "./builtins.js"
import { apiCall } from "./local-api.js"
import { tlog } from "./log.js"

type Context = Plugin.Context

export interface UndoStashEntry {
  sessionID: string
}

/** Paginated model picker (buttons). messageID = edit in place, else send new. */
export async function renderModelPicker(
  ctx: Context,
  bot: TelegramBot,
  chatId: number,
  page: number,
  messageID?: number,
  current?: string,
): Promise<void> {
  const res = await ctx.model.list()
  const models = res.data
    .filter((m) => m.status !== "deprecated")
    .map((m) => ({ label: `${m.providerID}/${m.id}`, key: `${m.providerID}|${m.id}` }))
    .filter((m) => m.key.length <= 56)
  const perPage = 8
  const pages = Math.max(1, Math.ceil(models.length / perPage))
  const p = Math.min(Math.max(0, Math.floor(page)), pages - 1)
  const slice = models.slice(p * perPage, (p + 1) * perPage)
  const rows: Array<Array<{ text: string; callback_data: string }>> = slice.map((m) => [
    { text: m.label.slice(0, 60), callback_data: `mdl:${m.key}` },
  ])
  rows.push([
    { text: "◀", callback_data: `mdlp:${(p - 1 + pages) % pages}` },
    { text: `${p + 1}/${pages}`, callback_data: "mdlp:noop" },
    { text: "▶", callback_data: `mdlp:${(p + 1) % pages}` },
  ])
  const text = `🧠 model${current ? ` (current: ${current})` : ""} — pick one:`
  const keyboard = { inline_keyboard: rows }
  if (messageID !== undefined) {
    await bot.editMessageText(chatId, messageID, text, { keyboard })
  } else {
    await bot.sendMessage(chatId, text, { keyboard })
  }
}

export async function dispatch(input: {
  ctx: Context
  bot: TelegramBot
  chatId: number
  text: string
  sessions: Sessions
  registry: Registry
  undoStash: Map<string, UndoStashEntry>
}): Promise<void> {
  const { ctx, bot, chatId, text, sessions, registry, undoStash } = input
  const [rawCmd, ...rest] = text.trim().split(/\s+/)
  const cmd = (rawCmd ?? "").slice(1).split("@")[0]?.toLowerCase() ?? ""
  const reply = (body: string) => bot.sendMessage(chatId, body)

  try {
    switch (cmd) {
      case "start":
      case "help":
        await reply(helpText(registry))
        return

      case "new": {
        const sid = await sessions.create(chatId)
        const info = await ctx.session.get({ sessionID: sid })
        await reply(`🆕 new session ${sid}\n${info.title ?? "(untitled)"}`)
        return
      }

      case "status": {
        const sid = await sessions.current(chatId)
        if (!sid) {
          await reply("no active session — send a message first")
          return
        }
        const info = await ctx.session.get({ sessionID: sid })
        const model = info.model ? `${info.model.providerID}/${info.model.id}` : "(default)"
        const outcome = info.outcome ? ` · last: ${info.outcome}` : ""
        const tokens = (info.tokens?.input ?? 0) + (info.tokens?.output ?? 0)
        await reply(
          `session ${sid}\n${info.title ?? "(untitled)"}\n` +
            `agent: ${info.agent ?? "(default)"} · model: ${model}${outcome}\n` +
            `tokens: ${tokens} · cost: $${typeof info.cost === "number" ? info.cost.toFixed(4) : info.cost ?? 0}`,
        )
        return
      }

      case "stop": {
        const sid = await sessions.current(chatId)
        if (!sid) {
          await reply("no active session")
          return
        }
        await ctx.session.interrupt({ sessionID: sid })
        await reply("⏹ interrupted")
        return
      }

      case "compact": {
        const sid = await sessions.ensure(chatId)
        try {
          await apiCall("POST", `/api/session/${sid}/compact`, {})
          await reply("🧹 compaction requested")
        } catch (err) {
          await reply(`⚠️ compact unavailable: ${String(err)}`)
        }
        return
      }

      case "init": {
        const sid = await sessions.ensure(chatId)
        try {
          await ctx.session.command({ sessionID: sid, name: "init", text: "" })
          await reply("🧭 init started — AGENTS.md flow running")
        } catch (err) {
          await reply(`⚠️ init failed: ${String(err)}`)
        }
        return
      }

      case "undo": {
        const sid = await sessions.current(chatId)
        if (!sid) {
          await reply("no active session")
          return
        }
        try {
          const messages = await ctx.session.context({ sessionID: sid })
          const lastUser = [...messages].reverse().find((m) => m.type === "user")
          if (!lastUser) {
            await reply("nothing to undo")
            return
          }
          const res = await apiCall<{
            data?: { files?: Array<{ file: string; additions?: number; deletions?: number }> }
          }>("POST", `/api/session/${sid}/revert/stage`, { messageID: lastUser.id })
          const files = res?.data?.files ?? []
          if (files.length === 0) {
            await reply("nothing to undo (no file changes in the last turn)")
            return
          }
          undoStash.set(String(chatId), { sessionID: sid })
          const lines = files
            .slice(0, 10)
            .map(
              (f) =>
                `• ${f.file}${f.additions || f.deletions ? ` (+${f.additions ?? 0} −${f.deletions ?? 0})` : ""}`,
            )
          const keyboard = {
            inline_keyboard: [
              [
                { text: "✅ Confirm undo", callback_data: "undo:confirm" },
                { text: "🚫 Cancel", callback_data: "undo:cancel" },
              ],
            ],
          }
          await bot.sendMessage(chatId, `⏪ <b>Undo last turn?</b>\n${lines.join("\n")}`, {
            html: true,
            keyboard,
          })
        } catch (err) {
          await reply(`⚠️ undo failed: ${String(err)}`)
        }
        return
      }

      case "sessions": {
        try {
          const res = await apiCall<{
            data?: Array<{ id: string; title?: string; time?: { updated?: number } }>
          }>("GET", "/api/session?limit=10&order=desc")
          const rows = (res?.data ?? []).slice(0, 8)
          if (rows.length === 0) {
            await reply("no sessions")
            return
          }
          const keyboard = {
            inline_keyboard: rows.map((s) => [
              {
                text: `${(s.title ?? "(untitled)").slice(0, 40)} · ${s.id.slice(-6)}`,
                callback_data: `sess:${s.id}`,
              },
            ]),
          }
          await bot.sendMessage(chatId, "🗂 pick a session:", { keyboard })
        } catch (err) {
          await reply(`⚠️ sessions unavailable: ${String(err)}`)
        }
        return
      }

      case "redo":
      case "share": {
        await reply(`/${cmd} is not available through the v2 plugin API`)
        return
      }

      case "agent": {
        const sid = await sessions.ensure(chatId)
        const arg = rest[0]
        if (!arg) {
          const list = await ctx.agent.list()
          const agents = list.data.filter((a) => !a.hidden).slice(0, 20)
          if (agents.length === 0) {
            await reply("no agents available")
            return
          }
          const keyboard = {
            inline_keyboard: agents.map((a) => [
              {
                text: `${a.id}${a.mode === "primary" ? " ★" : ""} — ${(a.description ?? a.name ?? "").slice(0, 40)}`,
                callback_data: `agt:${a.id}`,
              },
            ]),
          }
          await bot.sendMessage(chatId, "🤖 pick an agent:", { keyboard })
          return
        }
        await ctx.session.switchAgent({ sessionID: sid, agent: arg })
        await reply(`agent → ${arg}`)
        return
      }

      case "model": {
        const sid = await sessions.ensure(chatId)
        const arg = rest[0]
        const info = await ctx.session.get({ sessionID: sid })
        if (!arg) {
          const cur = info.model ? `${info.model.providerID}/${info.model.id}` : ""
          await renderModelPicker(ctx, bot, chatId, 0, undefined, cur)
          return
        }
        const slash = arg.indexOf("/")
        if (slash < 1) {
          await reply("format: /model <providerID>/<modelID>")
          return
        }
        await ctx.session.switchModel({
          sessionID: sid,
          model: { providerID: arg.slice(0, slash), id: arg.slice(slash + 1) },
        })
        await reply(`model → ${arg}`)
        return
      }

      case "history": {
        const sid = await sessions.current(chatId)
        if (!sid) {
          await reply("no active session")
          return
        }
        const n = Math.min(Math.max(Number(rest[0] ?? "6") || 6, 1), 20)
        const messages = await ctx.session.context({ sessionID: sid })
        const tail = messages.slice(-n)
        const lines: string[] = []
        for (const m of tail) {
          if (m.type === "user") {
            lines.push(`🧑 ${m.text.slice(0, 400)}`)
          } else if (m.type === "assistant") {
            const body = m.content
              .map((c) => (c.type === "text" ? (c as { text?: string }).text ?? "" : ""))
              .filter(Boolean)
              .join(" ")
            if (body) lines.push(`🤖 ${body.slice(0, 400)}`)
          }
        }
        await reply(lines.length ? lines.join("\n\n") : "(empty session)")
        return
      }

      case "sendfile": {
        const p = rest.join(" ").trim()
        if (!p) {
          await reply("usage: /sendfile <path>")
          return
        }
        const { stat } = await import("node:fs/promises")
        try {
          const st = await stat(p)
          if (!st.isFile()) throw new Error("not a file")
        } catch {
          await reply(`⚠️ not a readable file: ${p}`)
          return
        }
        try {
          await bot.sendPhoto(chatId, p, p)
          await reply("📎 sent")
        } catch (err) {
          await reply(`⚠️ send failed: ${String(err)}`)
        }
        return
      }

      default: {
        const entry = registry.byTg.get(cmd)
        if (entry && entry.kind === "custom") {
          const sid = await sessions.ensure(chatId)
          const args = rest.join(" ")
          await ctx.session.command({ sessionID: sid, name: entry.oc, text: args })
          tlog(`custom command /${cmd} → ${entry.oc} (session ${sid})`)
          return
        }
        await reply(`unknown command: ${rawCmd}\n\n${helpText(registry)}`)
        return
      }
    }
  } catch (err) {
    tlog(`command /${cmd} failed: ${String(err)}`)
    await reply(`⚠️ /${cmd} failed: ${String(err)}`).catch(() => {})
  }
}
