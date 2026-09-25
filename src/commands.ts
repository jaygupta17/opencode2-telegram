import type { Plugin } from "@opencode/plugin"
import type { TelegramBot } from "./bot.js"
import type { Sessions } from "./sessions.js"
import { tlog } from "./log.js"

type Context = Plugin.Context

const HELP = `opencode-telegram commands:
/new       start a fresh session
/status    current session info
/stop      interrupt the running turn
/compact   compact conversation context
/agent     list agents · /agent <id> switches
/model     current model · /model <provider>/<id> switches
/history [n]  last messages (default 6)
/help      this message`


export async function dispatch(input: {
  ctx: Context
  bot: TelegramBot
  chatId: number
  text: string
  sessions: Sessions
}): Promise<void> {
  const { ctx, bot, chatId, text, sessions } = input
  const [rawCmd, ...rest] = text.trim().split(/\s+/)
  const cmd = (rawCmd ?? "").slice(1).split("@")[0]?.toLowerCase() ?? ""
  const reply = (body: string) => bot.sendMessage(chatId, body)

  try {
    switch (cmd) {
      case "start":
      case "help":
        await reply(HELP)
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
        const sid = await sessions.current(chatId)
        if (!sid) {
          await reply("no active session")
          return
        }
        // plugin domain exposes session.command, not session.compact
        await ctx.session.command({ sessionID: sid, name: "compact", text: "" })
        await reply("🧹 compaction queued")
        return
      }

      case "agent": {
        const sid = await sessions.ensure(chatId)
        const arg = rest[0]
        if (!arg) {
          const list = await ctx.agent.list()
          const rows = list.data
            .filter((a) => !a.hidden)
            .map((a) => `${a.id} — ${a.description ?? a.name}${a.mode === "primary" ? " ·" : ""}`)
          await reply(`agents (· = primary):\n${rows.join("\n")}`)
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
          const cur = info.model ? `${info.model.providerID}/${info.model.id}` : "(default)"
          await reply(`model: ${cur}\nswitch: /model <provider>/<id>`)
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

      default:
        await reply(`unknown command: ${rawCmd}\n\n${HELP}`)
        return
    }
  } catch (err) {
    tlog(`command /${cmd} failed: ${String(err)}`)
    await reply(`⚠️ /${cmd} failed: ${String(err)}`).catch(() => {})
  }
}
