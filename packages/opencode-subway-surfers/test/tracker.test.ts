import { describe, expect, it } from "vitest"
import { Tracker, type TrackerEvent } from "../src/tracker.ts"

const LOCATION = "/workspace/project"

function event(type: string, data: Record<string, unknown> = {}, location = LOCATION): TrackerEvent {
  return { type, data, location: { directory: location } }
}

function tracker() {
  return new Tracker({ location: LOCATION, now: () => 1_763_380_000_000 })
}

describe("Tracker", () => {
  it("stays unknown until it sees any activity", () => {
    expect(tracker().phase()).toBe("unknown")
  })

  it("is working while a session executes and waiting after idle", () => {
    const t = tracker()
    t.handle(event("session.execution.started", { sessionID: "ses_1" }))
    expect(t.phase()).toBe("working")
    expect(t.snapshot().reason).toBe("execution")
    expect(t.snapshot().sessions.busy).toBe(1)

    t.handle(event("session.execution.succeeded", { sessionID: "ses_1" }))
    expect(t.phase()).toBe("waiting")
    expect(t.snapshot().reason).toBe("idle")
  })

  it("does not pause while a background shell is running", () => {
    const t = tracker()
    t.handle(event("session.execution.started", { sessionID: "ses_1" }))
    t.handle(event("session.idle", { sessionID: "ses_1" }))
    t.handle(
      event("shell.created", {
        info: { id: "sh_1", status: "running", command: "pnpm dev" },
      }),
    )

    expect(t.phase()).toBe("working")
    expect(t.snapshot().reason).toBe("background-shell")
    expect(t.snapshot().shells.running).toBe(1)

    t.handle(event("shell.exited", { id: "sh_1", status: "exited", exit: 0 }))
    expect(t.phase()).toBe("waiting")
    expect(t.snapshot().shells.running).toBe(0)
  })

  it("keeps the game running for background work reported by the idle hook", () => {
    const t = tracker()
    t.markKnownIdle()
    t.setIdleBackground("ses_1", [{ kind: "shell", shellID: "sh_2", command: "vite" }])
    expect(t.phase()).toBe("working")
    expect(t.snapshot().shells.running).toBe(1)

    t.setIdleBackground("ses_1", [])
    expect(t.phase()).toBe("waiting")
  })

  it("waits for a permission prompt and resumes after the reply", () => {
    const t = tracker()
    t.handle(event("session.execution.started", { sessionID: "ses_1" }))
    t.handle(event("permission.asked", { id: "per_1", sessionID: "ses_1", action: "bash", resources: [] }))
    expect(t.phase()).toBe("waiting")
    expect(t.snapshot().reason).toBe("permission")

    t.handle(event("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "once" }))
    expect(t.phase()).toBe("working")
  })

  it("can be configured to ignore permission prompts", () => {
    const t = new Tracker({ location: LOCATION, pauseOnPermission: false })
    t.handle(event("session.execution.started", { sessionID: "ses_1" }))
    t.handle(event("permission.asked", { id: "per_1", sessionID: "ses_1" }))
    expect(t.phase()).toBe("working")
  })

  it("ignores events from another location", () => {
    const t = tracker()
    t.handle(event("session.execution.started", { sessionID: "ses_1" }, "/tmp/other"))
    expect(t.phase()).toBe("unknown")
    expect(t.snapshot().sessions.busy).toBe(0)
  })

  it("cleans up deleted sessions", () => {
    const t = tracker()
    t.handle(event("session.execution.started", { sessionID: "ses_1" }))
    t.handle(event("permission.asked", { id: "per_1", sessionID: "ses_1" }))
    t.handle(event("session.deleted", { sessionID: "ses_1" }))
    expect(t.phase()).toBe("waiting")
    expect(t.snapshot().sessions).toEqual({ busy: 0, pendingPermissions: 0, background: 0 })
  })

  it("treats a session shell as work", () => {
    const t = tracker()
    t.markKnownIdle()
    t.handle(event("session.shell.started", { sessionID: "ses_1", shell: { id: "sh_3" } }))
    expect(t.phase()).toBe("working")
    t.handle(event("session.shell.ended", { sessionID: "ses_1", shell: { id: "sh_3" } }))
    expect(t.phase()).toBe("waiting")
  })
})
