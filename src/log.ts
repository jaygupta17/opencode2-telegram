import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Proof-file logging. The opencode server swallows plugin console output,
 * so every log line is appended to <repo>/.tg-proof (resolved from this
 * module's location — works from any process that loads the plugin).
 */
const PROOF = fileURLToPath(new URL("../.tg-proof", import.meta.url))
const ME = `pid${process.pid}`

export const tlog = (line: string): void => {
  console.log(`[tg ${ME}] ${line}`)
  try {
    appendFileSync(PROOF, `${new Date().toISOString()} [tg ${ME}] ${line}\n`)
  } catch {
    /* proof file is best-effort */
  }
}
