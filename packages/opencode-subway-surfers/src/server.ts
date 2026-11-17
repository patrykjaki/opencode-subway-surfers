import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-subway-surfers",
  async setup() {
    // Lifecycle tracking and bridge heartbeats run in the TUI entrypoint (./tui)
    // so the game is never paused when no terminal TUI is active.
  },
})
