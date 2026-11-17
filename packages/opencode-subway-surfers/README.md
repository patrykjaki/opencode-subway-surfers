# opencode-subway-surfers

OpenCode V2 TUI plugin that launches the `subway-wrapper` Tauri desktop app, pauses Subway Surfers whenever the agent waits for your prompt (with zero background shells running), resumes after a 3-second `3-2-1` countdown when the agent works, and closes the game window when turned off or when the OpenCode TUI exits.

## Install

1. Install the desktop wrapper (`subway-wrapper`) from [github.com/patrykjaki/opencode-subway-surfers](https://github.com/patrykjaki/opencode-subway-surfers) (via Nix `nix profile install github:patrykjaki/opencode-subway-surfers` or `npm run build` into `/Applications/Subway Surfers.app` / `$PATH`).
2. Add the plugin to OpenCode:

```sh
opencode plugin add opencode-subway-surfers
```

Or add to `opencode.json` / `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-subway-surfers",
      "options": {
        "autoLaunch": true,
        "pauseOnPermission": true,
        "debounceMs": 250,
        "heartbeatMs": 2000,
        "verbose": false
      }
    }
  ]
}
```

## TUI Controls

- `/subway` — toggle Subway Surfers ON / OFF
- `/subway on` — turn ON and launch the Subway Surfers window
- `/subway off` — turn OFF and close the Subway Surfers window
- Command Palette (`Ctrl+P`) → **Subway Surfers: Turn ON / Turn OFF**
