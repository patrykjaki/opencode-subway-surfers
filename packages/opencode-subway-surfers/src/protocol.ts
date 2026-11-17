export const PROTOCOL_VERSION = 1 as const
export const DISCOVERY_SCHEMA = 1 as const
export const BRIDGE_APP = "subway-wrapper"
export const DEFAULT_BRIDGE_FILE = "~/.subway-autopause/bridge.json"

export type AgentPhase = "working" | "waiting" | "offline"

export type AgentReason =
  | "execution"
  | "idle"
  | "permission"
  | "background-shell"
  | "background"
  | "startup"
  | "plugin-unload"

export interface AgentSnapshot {
  v: typeof PROTOCOL_VERSION
  phase: AgentPhase
  reason: AgentReason
  location: string
  sessions: {
    busy: number
    pendingPermissions: number
    background: number
  }
  shells: {
    running: number
  }
  sentAt: number
}

export interface DiscoveryFile {
  schema: typeof DISCOVERY_SCHEMA
  app: typeof BRIDGE_APP
  version: string
  pid: number
  port: number
  token: string
  startedAt: number
}

export function isDiscoveryFile(value: unknown): value is DiscoveryFile {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    v.schema === DISCOVERY_SCHEMA &&
    v.app === BRIDGE_APP &&
    typeof v.port === "number" &&
    v.port > 0 &&
    v.port < 65_536 &&
    typeof v.token === "string" &&
    v.token.length >= 16 &&
    typeof v.pid === "number"
  )
}
