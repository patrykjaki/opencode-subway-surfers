#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const bridgeFile =
  process.env.SUBWAY_BRIDGE_FILE ||
  join(homedir(), ".subway-autopause", "bridge.json")
const arg = (process.argv[2] || "waiting").toLowerCase()
const shellCount = Number(process.argv[3] || 1)

const bridge = JSON.parse(await readFile(bridgeFile, "utf8"))
const now = Date.now()

const states = {
  working: {
    phase: "working",
    reason: "execution",
    sessions: { busy: 1, pendingPermissions: 0, background: 0 },
    shells: { running: 0 },
  },
  waiting: {
    phase: "waiting",
    reason: "idle",
    sessions: { busy: 0, pendingPermissions: 0, background: 0 },
    shells: { running: 0 },
  },
  permission: {
    phase: "waiting",
    reason: "permission",
    sessions: { busy: 0, pendingPermissions: 1, background: 0 },
    shells: { running: 0 },
  },
  shell: {
    phase: "working",
    reason: "background-shell",
    sessions: { busy: 0, pendingPermissions: 0, background: shellCount },
    shells: { running: shellCount },
  },
  offline: {
    phase: "offline",
    reason: "plugin-unload",
    sessions: { busy: 0, pendingPermissions: 0, background: 0 },
    shells: { running: 0 },
  },
}

const state = states[arg]
if (!state) {
  console.error(`Unknown state "${arg}". Use: ${Object.keys(states).join(", ")}`)
  process.exit(1)
}

const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/state`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${bridge.token}`,
  },
  body: JSON.stringify({
    v: 1,
    ...state,
    location: process.cwd(),
    sentAt: now,
  }),
})

console.log(arg, response.status, await response.text())
