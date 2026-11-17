# opencode-subway-surfers

A lightweight **Tauri 2** desktop wrapper (portrait phone-sized `430×820` window) for web **Subway Surfers**, paired with the **`opencode-subway-surfers`** OpenCode V2 plugin:

- **Toggle right from OpenCode TUI**:
  - Run `/subway` (`/subway on` / `/subway off`) or open the Command Palette (`Ctrl+P` → **Subway Surfers: Turn ON / Turn OFF**).
  - Turning **ON** automatically launches the Subway Surfers window (if not already running); turning **OFF** or exiting the OpenCode TUI closes the game window cleanly.
- **Auto-pause when waiting**: whenever the agent finishes its turn and waits for your prompt (with zero background shells or subagents running), the game freezes in place (`requestAnimationFrame`, virtual `performance.now()`, and Web Audio suspended).
- **3-second resume countdown**: as soon as the agent starts working again (or runs a background shell), a `3 · 2 · 1` countdown gives you 3 seconds to grab your arrow keys before unfreezing.
- **Fail-open**: closing the game never blocks OpenCode, and if the OpenCode TUI disconnects unexpectedly, the game automatically resumes after `6 s`.

## Quick Start

```sh
npm install
npm run build --workspace opencode-subway-surfers
npm run dev
```

Override the game URL at runtime if needed:

```sh
SUBWAY_URL="https://staticquasar931.github.io/SubwaySurfers/" npm run dev
```

Test agent state transitions without OpenCode:

```sh
npm run mock waiting
npm run mock working
npm run mock shell
```

## Nix (`flake.nix`)

```sh
nix run .        # build and launch subway-wrapper
nix develop      # dev shell with Rust, Node, and WebKitGTK / macOS deps
```

## Publishing the OpenCode Plugin to npm

`packages/opencode-subway-surfers` is standalone with no private workspace dependencies:

```sh
cd packages/opencode-subway-surfers
npm test
npm run typecheck
npm publish --access public
```

Then add it to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-subway-surfers",
      "options": {
        "heartbeatMs": 2000
      }
    }
  ]
}
```
