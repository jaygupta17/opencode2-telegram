import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Proof-file logging. The opencode server swallows plugin console output,
 * so every log line is appended to <repo>/.tg-proof (resolved from this
 * module's location — works from any process that loads the plugin).
 */
const PROOF = fileURLToPath(new URL("../.tg-proof", import.meta.url))

export const tlog = (line: string): void => {
  console.log(`[tg] ${line}`)
  try {
    appendFileSync(PROOF, `${new Date().toISOString()} [tg] ${line}\n`)
  } catch {
    /* proof file is best-effort */
  }
}
