import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * HTTP access to the local OpenCode server for endpoints the plugin domain
 * does not expose (session.compact, session.revert.*, session list).
 *
 * Resolution:
 *   1. config override (options.localApi.port / .password)
 *   2. process env (OPENCODE_PASSWORD) + `--port` from this process's argv
 *   3. ~/.config/opencode/service.json (password) + default port 4096
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

export function resolveLocalApi(override?: { port?: number; password?: string }): LocalApi | undefined {
  if (cache !== undefined && !override) return cache ?? undefined
  const ov = override ?? configured
  let port = ov?.port ?? 0
  let password = ov?.password ?? process.env.OPENCODE_PASSWORD ?? ""

  const argv = process.argv
  const pi = argv.indexOf("--port")
  if (!port && pi >= 0) port = Number(argv[pi + 1] ?? 0)
  if (!port) {
    const eq = argv.find((a) => a.startsWith("--port="))
    if (eq) port = Number(eq.slice("--port=".length))
  }

  if (!password || !port) {
    try {
      const sj = JSON.parse(
        readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8"),
      ) as { password?: string }
      if (!password && sj.password) password = sj.password
    } catch {
      /* no service.json */
    }
  }
  if (!port) port = 4096

  if (!password || !Number.isFinite(port) || port <= 0) {
    cache = null
    return undefined
  }
  const api = {
    url: `http://127.0.0.1:${port}`,
    auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  }
  if (!override) cache = api
  return api
}

export async function apiCall<T>(
  method: string,
  path: string,
  body?: unknown,
  override?: { port?: number; password?: string },
): Promise<T> {
  const attempt = async (resetCache: boolean): Promise<T> => {
    const api = resolveLocalApi(override)
    if (!api) throw new Error("local api unavailable (no port/password detected)")
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
      const err = new Error(`local api ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`)
      if (resetCache && (res.status === 401 || res.status === 403 || res.status === 502)) {
        cache = undefined
      }
      throw err
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
