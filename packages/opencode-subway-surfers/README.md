# opencode-subway-surfers

OpenCode V2 plugin that automatically launches the Subway Surfers Tauri wrapper when enabled in the TUI, pauses it whenever the agent is waiting for your prompt (with zero background shells running), resumes after a 3-second `3-2-1` countdown when the agent works, and closes the game window when disabled or when the OpenCode TUI exits.

## TUI Controls

- `/subway` — toggle Subway Surfers ON / OFF
- `/subway on` — turn ON and launch the Subway Surfers window
- `/subway off` — turn OFF and close the Subway Surfers window
- Command Palette (`Ctrl+P`) → **Subway Surfers: Turn ON / Turn OFF**

## Configuration

Add to `opencode.json`:

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
