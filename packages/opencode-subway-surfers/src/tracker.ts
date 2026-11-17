import type { AgentPhase, AgentReason, AgentSnapshot } from "./protocol.js"

/** Public event shape we rely on. Kept loose so the tracker can be tested without the server. */
export interface TrackerEvent {
  type: string
  data?: Record<string, unknown>
  location?: { directory?: string }
}

export interface IdleBackgroundItem {
  kind: "shell" | "subagent" | "image"
  shellID?: string
  childSessionID?: string
  command?: string
}

export type TrackerPhase = AgentPhase | "unknown"

export interface TrackerOptions {
  location: string
  pauseOnPermission?: boolean
  now?: () => number
}

export interface TrackerSnapshot extends Omit<AgentSnapshot, "phase"> {
  phase: TrackerPhase
}

/** Drops the internal `unknown` phase so the snapshot can be sent on the wire. */
export function toWireSnapshot(snapshot: TrackerSnapshot): AgentSnapshot | undefined {
  if (snapshot.phase === "unknown") return undefined
  return { ...snapshot, phase: snapshot.phase }
}

function normaliseLocation(value: string): string {
  return value.trim().replace(/[\\/]+$/, "")
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Pure aggregation of OpenCode events into one "is the agent working?" answer.
 *
 * Rules:
 *  - a running background shell always means working, even when every session is idle
 *  - a pending permission prompt means waiting (the user has to answer)
 *  - any busy session means working
 *  - before we have seen anything we answer `unknown`, so the game is never paused on startup
 */
export class Tracker {
  private readonly busy = new Set<string>()
  private readonly permissions = new Map<string, string>()
  private readonly shells = new Set<string>()
  private readonly sessionShells = new Set<string>()
  private readonly background = new Map<string, IdleBackgroundItem[]>()
  private readonly pauseOnPermission: boolean
  private readonly now: () => number
  private readonly location: string
  private seen = false
  private reason: AgentReason = "startup"

  constructor(options: TrackerOptions) {
    this.location = normaliseLocation(options.location)
    this.pauseOnPermission = options.pauseOnPermission ?? true
    this.now = options.now ?? Date.now
  }

  /** Marks a session as busy (also used for startup reconciliation). */
  markBusy(sessionID: string): boolean {
    if (!sessionID) return false
    const changed = !this.busy.has(sessionID)
    this.busy.add(sessionID)
    this.background.delete(sessionID)
    if (changed) this.seen = true
    return changed
  }

  /** Marks the location as known-idle (startup reconciliation saw sessions, none running). */
  markKnownIdle(): void {
    this.seen = true
  }

  /** Feeds the `experimental.idle` hook, which lists work still running for an idle session. */
  setIdleBackground(sessionID: string, items: readonly IdleBackgroundItem[]): boolean {
    this.busy.delete(sessionID)
    this.seen = true
    if (items.length === 0) {
      return this.background.delete(sessionID)
    }
    this.background.set(sessionID, items.map((item) => ({ ...item })))
    return true
  }

  handle(event: TrackerEvent): boolean {
    if (!this.inLocation(event)) return false
    const data = event.data ?? {}
    switch (event.type) {
      case "session.execution.started": {
        return this.markBusy(stringValue(data.sessionID) ?? "")
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const id = stringValue(data.sessionID)
        if (!id) return false
        return this.busy.delete(id)
      }
      case "session.idle": {
        const id = stringValue(data.sessionID)
        if (!id) return false
        this.seen = true
        return this.busy.delete(id)
      }
      case "session.deleted": {
        const id = stringValue(data.sessionID)
        if (!id) return false
        this.busy.delete(id)
        this.background.delete(id)
        for (const [requestID, sessionID] of this.permissions) {
          if (sessionID === id) this.permissions.delete(requestID)
        }
        return true
      }
      case "permission.asked": {
        const requestID = stringValue(data.id)
        const sessionID = stringValue(data.sessionID)
        if (!requestID || !sessionID) return false
        this.permissions.set(requestID, sessionID)
        this.seen = true
        return true
      }
      case "permission.replied": {
        const requestID = stringValue(data.requestID)
        if (!requestID) return false
        return this.permissions.delete(requestID)
      }
      case "shell.created": {
        const info = (data.info ?? {}) as Record<string, unknown>
        const id = stringValue(info.id)
        if (!id || info.status !== "running") return false
        this.shells.add(id)
        this.seen = true
        return true
      }
      case "shell.exited":
      case "shell.deleted": {
        const id = stringValue(data.id)
        if (!id) return false
        this.shells.delete(id)
        this.forgetBackgroundShell(id)
        return true
      }
      case "session.shell.started": {
        const shell = (data.shell ?? {}) as Record<string, unknown>
        const id = stringValue(shell.id)
        if (!id) return false
        this.sessionShells.add(id)
        this.seen = true
        return true
      }
      case "session.shell.ended": {
        const shell = (data.shell ?? {}) as Record<string, unknown>
        const id = stringValue(shell.id)
        if (!id) return false
        return this.sessionShells.delete(id)
      }
      case "location.shutdown": {
        this.clear()
        return true
      }
      default:
        return false
    }
  }

  phase(): TrackerPhase {
    return this.snapshot().phase
  }

  snapshot(): TrackerSnapshot {
    const backgroundItems = [...this.background.values()].flat()
    const runningShells = new Set<string>([...this.shells, ...this.sessionShells])
    for (const item of backgroundItems) {
      if (item.kind === "shell" && item.shellID) runningShells.add(item.shellID)
    }

    let phase: TrackerPhase = "unknown"
    let reason: AgentReason = this.reason

    if (runningShells.size > 0) {
      phase = "working"
      reason = "background-shell"
    } else if (backgroundItems.length > 0) {
      phase = "working"
      reason = "background"
    } else if (this.pauseOnPermission && this.permissions.size > 0) {
      phase = "waiting"
      reason = "permission"
    } else if (this.busy.size > 0) {
      phase = "working"
      reason = "execution"
    } else if (this.seen) {
      phase = "waiting"
      reason = "idle"
    }

    this.reason = reason
    return {
      v: 1,
      phase,
      reason,
      location: this.location,
      sessions: {
        busy: this.busy.size,
        pendingPermissions: this.permissions.size,
        background: backgroundItems.length,
      },
      shells: { running: runningShells.size },
      sentAt: this.now(),
    }
  }

  private inLocation(event: TrackerEvent): boolean {
    const directory = event.location?.directory
    if (!directory) return true
    return normaliseLocation(directory) === this.location
  }

  private forgetBackgroundShell(shellID: string): void {
    for (const [sessionID, items] of this.background) {
      const next = items.filter((item) => !(item.kind === "shell" && item.shellID === shellID))
      if (next.length === items.length) continue
      if (next.length === 0) this.background.delete(sessionID)
      else this.background.set(sessionID, next)
    }
  }

  private clear(): void {
    this.busy.clear()
    this.permissions.clear()
    this.shells.clear()
    this.sessionShells.clear()
    this.background.clear()
    this.seen = false
    this.reason = "startup"
  }
}
