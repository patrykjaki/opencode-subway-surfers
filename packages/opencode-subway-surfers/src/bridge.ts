import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import {
  isDiscoveryFile,
  type AgentSnapshot,
  type DiscoveryFile,
} from "./protocol.js"

export interface BridgeClientOptions {
  bridgeFile: string
  verbose?: boolean
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

interface CacheEntry {
  discovery: DiscoveryFile
  readAt: number
}

const DISCOVERY_CACHE_MS = 2_000

export function expandHome(file: string): string {
  if (file === "~") return homedir()
  if (file.startsWith("~/") || file.startsWith("~\\")) return join(homedir(), file.slice(2))
  return isAbsolute(file) ? file : resolve(file)
}

/**
 * Tiny HTTP client for the Tauri bridge. All failures are swallowed: the plugin must
 * never break an OpenCode session because the game is closed.
 */
export class BridgeClient {
  private readonly file: string
  private readonly verbose: boolean
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private cache?: CacheEntry

  constructor(options: BridgeClientOptions) {
    this.file = expandHome(options.bridgeFile)
    this.verbose = options.verbose ?? false
    this.timeoutMs = options.timeoutMs ?? 900
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async health(): Promise<boolean> {
    const discovery = await this.readDiscovery(true)
    if (!discovery) return false

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${discovery.port}/v1/health`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${discovery.token}`,
        },
        signal: controller.signal,
      })
      return response.ok
    } catch {
      this.cache = undefined
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async quit(): Promise<boolean> {
    const discovery = await this.readDiscovery(true)
    if (!discovery) return false

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${discovery.port}/v1/quit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${discovery.token}`,
        },
        signal: controller.signal,
      })
      this.cache = undefined
      return response.ok
    } catch {
      this.cache = undefined
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async publish(snapshot: AgentSnapshot): Promise<boolean> {
    return this.post(snapshot, false)
  }

  async offline(snapshot: Pick<AgentSnapshot, "location" | "sessions" | "shells">): Promise<boolean> {
    return this.post(
      {
        v: 1,
        phase: "offline",
        reason: "plugin-unload",
        location: snapshot.location,
        sessions: snapshot.sessions,
        shells: snapshot.shells,
        sentAt: Date.now(),
      },
      false,
    )
  }

  private async post(snapshot: AgentSnapshot, retried: boolean): Promise<boolean> {
    const discovery = await this.readDiscovery(retried)
    if (!discovery) return false

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${discovery.port}/v1/state`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${discovery.token}`,
        },
        body: JSON.stringify(snapshot),
        signal: controller.signal,
      })

      if (response.status === 401 && !retried) {
        // The game restarted and rotated its token: re-read the discovery file once.
        this.cache = undefined
        return this.post(snapshot, true)
      }
      return response.ok
    } catch (error) {
      this.cache = undefined
      if (this.verbose) {
        console.debug("[subway-autopause] bridge unavailable:", error instanceof Error ? error.message : error)
      }
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  private async readDiscovery(force: boolean): Promise<DiscoveryFile | undefined> {
    if (!force && this.cache && Date.now() - this.cache.readAt < DISCOVERY_CACHE_MS) {
      return this.cache.discovery
    }

    try {
      const raw = await readFile(this.file, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (!isDiscoveryFile(parsed)) {
        if (this.verbose) console.debug("[subway-autopause] invalid discovery file:", this.file)
        return undefined
      }
      this.cache = { discovery: parsed, readAt: Date.now() }
      return parsed
    } catch {
      if (this.verbose) console.debug("[subway-autopause] no bridge at", this.file)
      return undefined
    }
  }
}
