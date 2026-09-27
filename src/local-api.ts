import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * HTTP access to the local OpenCode server for endpoints the plugin domain
 * does not expose (session.compact, session.revert.*, session list).
 *
 * The plugin can run inside different processes (serve on a known --port,
 * or a background service bound to a tailnet IP with a random port), so we
 * discover a working combination instead of assuming one:
 *
 *   candidates: argv --port / 4096 / 49374 on localhost, service.json host
 *   credentials: OPENCODE_PASSWORD env, then ~/.config/opencode/service.json
 *   options.localApi.port/.password override everything (tried first)
 *
 * Discovery probes GET /api/info (no side effects) and caches the winner.
 */
export interface LocalApi {
  url: string
  auth: string
}

let cache: LocalApi | null | undefined
let configured: { port?: number; password?: string } | undefined

/** Plugin-option overrides (options.localApi.port / .password). */
export function configureLocalApi(override?: { port?: number; password?: string }): void {
  configured = override
  cache = undefined
}

interface ServiceFile {
  password?: string
  hostname?: string
}

const readServiceFile = (): ServiceFile => {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8"),
    ) as ServiceFile
  } catch {
    return {}
  }
}

const argvPort = (): number => {
  const argv = process.argv
  const i = argv.indexOf("--port")
  if (i >= 0) {
    const p = Number(argv[i + 1] ?? 0)
    if (Number.isFinite(p) && p > 0) return p
  }
  const eq = argv.find((a) => a.startsWith("--port="))
  if (eq) {
    const p = Number(eq.slice("--port=".length))
    if (Number.isFinite(p) && p > 0) return p
  }
  return 0
}

const basic = (password: string): string =>
  `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

function candidates(): LocalApi[] {
  const svc = readServiceFile()
  const envPw = process.env.OPENCODE_PASSWORD
  const list: LocalApi[] = []
  const seen = new Set<string>()
  const add = (host: string, port: number, password?: string): void => {
    if (!password || !Number.isFinite(port) || port <= 0) return
    const url = `http://${host}:${port}`
    const auth = basic(password)
    const key = `${url}|${auth}`
    if (seen.has(key)) return
    seen.add(key)
    list.push({ url, auth })
  }

  // explicit override first
  if (configured?.port) {
    add("127.0.0.1", configured.port, configured.password ?? envPw ?? svc.password)
  }
  // serve-style process: its own argv port, env password
  add("127.0.0.1", argvPort(), envPw ?? svc.password)
  // common serve port
  add("127.0.0.1", 4096, envPw)
  add("127.0.0.1", 4096, svc.password)
  // background service: tailnet host + default service port, service password
  add(svc.hostname ?? "127.0.0.1", 49374, svc.password)
  add("127.0.0.1", 49374, svc.password)
  return list
}

async function pickApi(): Promise<LocalApi> {
  if (cache) return cache
  for (const candidate of candidates()) {
    try {
      const res = await fetch(`${candidate.url}/api/info`, {
        headers: { authorization: candidate.auth },
        signal: AbortSignal.timeout(2500),
      })
      if (res.ok) {
        cache = candidate
        return candidate
      }
    } catch {
      /* try next candidate */
    }
  }
  throw new Error("local api not reachable (no server candidate answered /api/info)")
}

export async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const attempt = async (resetCache: boolean): Promise<T> => {
    if (resetCache) cache = undefined
    const api = await pickApi()
    const res = await fetch(`${api.url}${path}`, {
      method,
      headers: {
        authorization: api.auth,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) {
      if (resetCache && (res.status === 401 || res.status === 403 || res.status === 502)) {
        cache = undefined
      }
      throw new Error(`local api ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`)
    }
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }
  try {
    return await attempt(true)
  } catch {
    return await attempt(false)
  }
}
