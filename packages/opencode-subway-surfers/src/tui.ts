import { spawn, type ChildProcess } from "node:child_process"
import { access } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin/tui"
import { BridgeClient } from "./bridge.js"
import { DEFAULT_BRIDGE_FILE } from "./protocol.js"
import { Tracker, toWireSnapshot, type TrackerEvent } from "./tracker.js"

const PLUGIN_ID = "opencode-subway-surfers"

function optionString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback
}

function optionBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function optionNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveSubwayExecutable(explicitBin?: string): Promise<string> {
  const candidates: string[] = []
  if (explicitBin) candidates.push(explicitBin)
  if (process.env.SUBWAY_APP_BIN) candidates.push(process.env.SUBWAY_APP_BIN)

  const here = dirname(fileURLToPath(import.meta.url))
  candidates.push(
    resolve(here, "../../../apps/subway/src-tauri/target/release/subway-wrapper"),
    resolve(here, "../../../apps/subway/src-tauri/target/debug/subway-wrapper"),
    resolve(process.cwd(), "apps/subway/src-tauri/target/release/subway-wrapper"),
    resolve(process.cwd(), "apps/subway/src-tauri/target/debug/subway-wrapper"),
    "/Applications/Subway Surfers.app/Contents/MacOS/subway-wrapper",
  )

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }
  return "subway-wrapper"
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const configEnabled = optionBoolean(ctx.options.enabled, true)
    if (!configEnabled) {
      return
    }

    const verbose = optionBoolean(ctx.options.verbose, false)
    const pauseOnPermission = optionBoolean(ctx.options.pauseOnPermission, true)
    const autoLaunch = optionBoolean(ctx.options.autoLaunch, true)
    const debounceMs = optionNumber(ctx.options.debounceMs, 250, 0, 10_000)
    const heartbeatMs = optionNumber(ctx.options.heartbeatMs, 2_000, 500, 30_000)
    const explicitBin = optionString(ctx.options.bin, "")
    const bridgeFile = optionString(
      process.env.SUBWAY_BRIDGE_FILE,
      optionString(ctx.options.bridgeFile, DEFAULT_BRIDGE_FILE),
    )

    const locationDir = ctx.location?.directory ?? process.cwd()
    const tracker = new Tracker({ location: locationDir, pauseOnPermission })
    const bridge = new BridgeClient({ bridgeFile, verbose })

    const [prefs, updatePrefs] = ctx.storage.store("subway-autopause", {
      initial: { enabled: true },
    })

    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let spawnedChild: ChildProcess | undefined
    let lastSentPhase: string | undefined
    let stopped = false

    const log = (message: string, error?: unknown) => {
      if (!verbose) return
      console.debug(`[${PLUGIN_ID}] ${message}`, error ?? "")
    }

    const emit = (force: boolean) => {
      if (stopped || !prefs.enabled) return
      const snapshot = tracker.snapshot()
      const wireSnapshot = toWireSnapshot(snapshot)
      if (!wireSnapshot) return

      if (!force && wireSnapshot.phase === "waiting" && lastSentPhase !== "waiting") {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined
          if (!stopped && prefs.enabled && tracker.phase() === "waiting") emit(true)
        }, debounceMs)
        return
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = undefined
      }
      lastSentPhase = wireSnapshot.phase
      void bridge.publish(wireSnapshot)
    }

    const schedule = () => {
      if (stopped || !prefs.enabled) return
      const phase = tracker.phase()
      if (phase === "unknown") return
      if (phase === "working") {
        emit(true)
        return
      }
      if (lastSentPhase === "waiting") {
        return
      }
      emit(false)
    }

    const syncInitialState = () => {
      try {
        for (const session of ctx.data.session.list()) {
          if (ctx.data.session.status(session.id) === "running") {
            tracker.markBusy(session.id)
          }
          const perms = ctx.data.session.permission.list(session.id) ?? []
          for (const perm of perms) {
            tracker.handle({
              type: "permission.asked",
              data: { id: perm.id, sessionID: session.id },
              location: ctx.location,
            })
          }
        }
        for (const shell of ctx.data.shell.list(ctx.location)) {
          if (shell.status === "running") {
            tracker.handle({
              type: "shell.created",
              data: { info: shell },
              location: ctx.location,
            })
          }
        }
        tracker.markKnownIdle()
        schedule()
      } catch (error) {
        log("could not reconcile TUI state (non-fatal)", error)
      }
    }

    const launchSubwayWindow = async () => {
      if (stopped || !prefs.enabled) return
      if (await bridge.health()) {
        emit(true)
        return
      }

      try {
        const bin = await resolveSubwayExecutable(explicitBin || undefined)
        const child = spawn(bin, [], {
          detached: true,
          stdio: "ignore",
          env: process.env,
        })
        child.on("error", (err) => log("failed to launch Subway Surfers window", err))
        child.on("exit", () => {
          if (spawnedChild === child) spawnedChild = undefined
        })
        child.unref()
        spawnedChild = child

        // Push initial agent state once the Tauri bridge finishes binding
        for (let attempt = 0; attempt < 20 && !stopped && prefs.enabled; attempt++) {
          await new Promise((r) => setTimeout(r, 250))
          if (await bridge.health()) {
            emit(true)
            return
          }
        }
      } catch (error) {
        log("error spawning Subway Surfers wrapper", error)
      }
    }

    const closeSubwayWindow = async () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = undefined
      }
      lastSentPhase = undefined
      await bridge.offline(tracker.snapshot())
      const closedViaBridge = await bridge.quit()
      if (!closedViaBridge && spawnedChild && !spawnedChild.killed) {
        try {
          spawnedChild.kill("SIGTERM")
        } catch {
          // Ignore if already exited.
        }
      }
      spawnedChild = undefined
    }

    const setPluginEnabled = async (next: boolean) => {
      await updatePrefs((draft) => {
        draft.enabled = next
      })
      if (next) {
        syncInitialState()
        await launchSubwayWindow()
        ctx.ui.toast.show({ message: "Subway Surfers: ON", variant: "success" })
      } else {
        await closeSubwayWindow()
        ctx.ui.toast.show({ message: "Subway Surfers: OFF", variant: "info" })
      }
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "subway.toggle",
          title: prefs.enabled
            ? "Subway Surfers: Turn OFF (close game)"
            : "Subway Surfers: Turn ON (open game)",
          group: "Subway Surfers",
          palette: true,
          slash: { name: "subway", aliases: ["subwaysurfers"], arguments: true },
          suggested: true,
          run: async (input) => {
            const arg = (input ?? "").trim().toLowerCase()
            if (arg === "on" || arg === "enable" || arg === "start") {
              await setPluginEnabled(true)
            } else if (arg === "off" || arg === "disable" || arg === "stop") {
              await setPluginEnabled(false)
            } else {
              await setPluginEnabled(!prefs.enabled)
            }
          },
        },
        {
          id: "subway.on",
          title: "Subway Surfers: Turn ON",
          group: "Subway Surfers",
          palette: true,
          enabled: () => !prefs.enabled,
          run: async () => setPluginEnabled(true),
        },
        {
          id: "subway.off",
          title: "Subway Surfers: Turn OFF",
          group: "Subway Surfers",
          palette: true,
          enabled: () => prefs.enabled,
          run: async () => setPluginEnabled(false),
        },
      ],
    }))

    const unlisten = ctx.data.listen(({ details }) => {
      if (tracker.handle(details as unknown as TrackerEvent)) {
        schedule()
      }
    })

    syncInitialState()
    void ctx.data.shell
      .sync(ctx.location)
      .then(() => {
        if (!stopped) syncInitialState()
      })
      .catch((error) => log("shell sync failed (non-fatal)", error))

    if (prefs.enabled && autoLaunch) {
      void launchSubwayWindow()
    }

    heartbeatTimer = setInterval(() => {
      if (!prefs.enabled || tracker.phase() === "unknown") return
      emit(true)
    }, heartbeatMs)

    log(`TUI plugin loaded for ${locationDir}; enabled=${prefs.enabled}`)

    return async () => {
      stopped = true
      unlisten()
      if (debounceTimer) clearTimeout(debounceTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      await closeSubwayWindow()
    }
  },
})
