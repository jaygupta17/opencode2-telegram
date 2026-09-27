import type { Plugin } from "@opencode/plugin"
import type { TelegramBot } from "./bot.js"
import { tlog } from "./log.js"

type Context = Plugin.Context

export type BuiltinKind = "prompt" | "api" | "unsupported"

export interface BuiltinEntry {
  tg: string
  oc: string
  description: string
  kind: BuiltinKind
}

export interface CustomEntry {
  tg: string
  oc: string
  description: string
  kind: "custom"
}

export type RegistryEntry = BuiltinEntry | CustomEntry

export interface Registry {
  byTg: Map<string, RegistryEntry>
  customs: CustomEntry[]
}

/** Curated built-in commands (class A = prompt, class B = api). */
export const BUILTINS: BuiltinEntry[] = [
  { tg: "init", oc: "init", description: "guided AGENTS.md setup", kind: "prompt" },
  { tg: "compact", oc: "compact", description: "compact the conversation context", kind: "api" },
  { tg: "undo", oc: "undo", description: "undo the last turn's file changes", kind: "api" },
  { tg: "sessions", oc: "sessions", description: "list and switch sessions", kind: "api" },
  { tg: "redo", oc: "redo", description: "redo (unsupported in v2 API)", kind: "unsupported" },
  { tg: "share", oc: "share", description: "share (unsupported in v2 API)", kind: "unsupported" },
]

/** Telegram command names: ^[a-z][a-z0-9_]{0,31}$ */
export const sanitizeName = (name: string): string => {
  let s = name.toLowerCase().replace(/[^a-z0-9_]/g, "_")
  if (!/^[a-z]/.test(s)) s = `x${s}`
  return s.slice(0, 32)
}

export interface RegistryOptions {
  builtins: boolean
  custom: boolean
  hidden: string[]
}

export async function buildRegistry(ctx: Context, opts: RegistryOptions): Promise<Registry> {
  const byTg = new Map<string, RegistryEntry>()
  const hidden = new Set(opts.hidden.map((h) => h.toLowerCase()))

  if (opts.builtins) {
    for (const b of BUILTINS) if (!hidden.has(b.tg)) byTg.set(b.tg, b)
  }

  const customs: CustomEntry[] = []
  if (opts.custom) {
    try {
      const list = await ctx.command.list()
      for (const c of list.data) {
        const tg = sanitizeName(c.name)
        if (byTg.has(tg) || hidden.has(tg)) continue
        const entry: CustomEntry = {
          tg,
          oc: c.name,
          description: c.description ?? `run /${c.name}`,
          kind: "custom",
        }
        byTg.set(tg, entry)
        customs.push(entry)
      }
    } catch (err) {
      tlog(`command.list failed: ${String(err)}`)
    }
  }
  return { byTg, customs }
}

const CORE_MENU: Array<{ command: string; description: string }> = [
  { command: "new", description: "Start a fresh session" },
  { command: "status", description: "Current session info" },
  { command: "stop", description: "Interrupt the running turn" },
  { command: "model", description: "Show or switch the model" },
  { command: "thinking", description: "Set the thinking/reasoning variant" },
  { command: "agent", description: "List or switch agents" },
  { command: "history", description: "Show recent messages" },
  { command: "sendfile", description: "Send a local file" },
  { command: "help", description: "Show all commands" },
  { command: "start", description: "Introduction" },
]

export const CORE_NAMES = new Set(CORE_MENU.map((c) => c.command))

/** Merge core + registry into the Telegram menu (max 100). */
export async function syncMenu(bot: TelegramBot, registry: Registry): Promise<void> {
  const seen = new Set(CORE_MENU.map((c) => c.command))
  const extra: Array<{ command: string; description: string }> = []
  for (const entry of registry.byTg.values()) {
    if (seen.has(entry.tg)) continue
    if (entry.kind === "unsupported") continue
    seen.add(entry.tg)
    extra.push({ command: entry.tg, description: entry.description.slice(0, 120) || entry.tg })
    if (CORE_MENU.length + extra.length >= 100) break
  }
  await bot.setMyCommands([...CORE_MENU, ...extra])
  tlog(`menu synced: ${CORE_MENU.length + extra.length} commands`)
}

export function helpText(registry: Registry): string {
  const builtins = BUILTINS.filter((b) => registry.byTg.get(b.tg) === b)
  const lines: string[] = [
    "🐝 bot",
    "/new /status /stop /model /thinking /agent /history /sendfile /help",
  ]
  if (builtins.length > 0) {
    lines.push("", "⚙️ opencode")
    for (const b of builtins) {
      const flag = b.kind === "unsupported" ? " (unsupported)" : ""
      lines.push(`/${b.tg} — ${b.description}${flag}`)
    }
  }
  if (registry.customs.length > 0) {
    lines.push("", "📜 your commands")
    for (const c of registry.customs) lines.push(`/${c.tg} — ${c.description}`)
  }
  return lines.join("\n")
}
