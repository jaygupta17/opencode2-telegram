import { Plugin } from "@opencode/plugin"
import { appendFileSync } from "node:fs"

/**
 * opencode-telegram — Phase 1 recon scaffold.
 *
 * Proves the v2 plugin loads inside the target process, that ctx.storage
 * persists, and enumerates the event types this plugin will later react to.
 * No Telegram traffic yet (needs a bot token — Phase 2).
 *
 * Logs go BOTH to console and to .tg-proof (append file) because plugin
 * console output routing differs between `run` and `serve` processes.
 */
const proof = (line: string) => {
  try {
    appendFileSync(new URL("../.tg-proof", import.meta.url), `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* proof file is best-effort */
  }
}

export default Plugin.define({
  id: "opencode-telegram",
  async setup(ctx) {
    const started = new Date().toISOString()
    const boot = `setup app=${ctx.app.version} channel=${ctx.app.channel} dir=${ctx.location.directory} options=${JSON.stringify(ctx.options)}`
    console.log(`[tg] ${boot}`)
    proof(`[tg] ${boot}`)

    const loads = ((await ctx.storage.get("loads")) as number | undefined) ?? 0
    await ctx.storage.set("loads", loads + 1)
    await ctx.storage.set("last-load", { at: started, version: ctx.app.version })
    console.log(`[tg] storage ok — load #${loads + 1}`)
    proof(`[tg] storage ok — load #${loads + 1}`)

    const ac = new AbortController()
    const seen = new Set<string>()
    let total = 0

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: ac.signal })) {
          total++
          if (!seen.has(event.type)) {
            seen.add(event.type)
            console.log(`[tg] event-type #${seen.size}: ${event.type}`)
            proof(`[tg] event-type #${seen.size}: ${event.type}`)
          }
        }
        proof("[tg] event stream closed")
      } catch (err) {
        proof(`[tg] event stream ended: ${err}`)
      }
    })()

    return () => {
      console.log(`[tg] cleanup after ${total} events (${seen.size} unique types)`)
      proof(`[tg] cleanup after ${total} events (${seen.size} unique types)`)
      ac.abort()
    }
  },
})
