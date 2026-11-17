# opencode-subway-surfers

A lightweight **Tauri 2** desktop wrapper (portrait phone-sized `430×820` window) for web **Subway Surfers**, paired with the **`opencode-subway-surfers`** OpenCode V2 TUI plugin:

- **Toggle right from OpenCode TUI**:
  - Run `/subway` (`/subway on` / `/subway off`) or use the Command Palette (`Ctrl+P` → **Subway Surfers: Turn ON / Turn OFF**).
  - Turning **ON** launches the Subway Surfers window automatically; turning **OFF** or closing OpenCode TUI closes the game window cleanly.
- **Auto-pause while waiting**: when the agent finishes its turn and waits for your prompt (with zero background shells or subagents running), the game freezes in place (`requestAnimationFrame`, virtual `performance.now()`, and Web Audio suspended).
- **3-second resume countdown**: as soon as the agent starts working again (or runs a background shell), a `3 · 2 · 1` countdown gives you 3 seconds to get back on the arrow keys before unfreezing.
- **Fail-open**: closing the game never blocks OpenCode, and if the OpenCode TUI disconnects unexpectedly, the game resumes automatically after `6 s`.

## Install & Run

### 1. Install the desktop app (`subway-wrapper`)

#### Option A: Nix (flakes)

```sh
nix profile install github:patrykjaki/opencode-subway-surfers
```

*(Or run it directly without installing: `nix run github:patrykjaki/opencode-subway-surfers`.)*

#### Option B: Build the release app from source (macOS / Linux)

Prerequisites: Node.js, Rust, and system WebView dependencies (Xcode Command Line Tools on macOS; WebKitGTK 4.1 on Linux).

```sh
git clone https://github.com/patrykjaki/opencode-subway-surfers.git
cd opencode-subway-surfers
npm install
npm run build
```

On macOS, move the generated `apps/subway/src-tauri/target/release/bundle/macos/Subway Surfers.app` into `/Applications/` (or put `apps/subway/src-tauri/target/release/subway-wrapper` on your `$PATH`, or set `SUBWAY_APP_BIN`).

### 2. Install the OpenCode plugin

```sh
opencode plugin add opencode-subway-surfers
```

Or add it manually to your `opencode.json` / `~/.config/opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-subway-surfers",
      "options": {
        "autoLaunch": true,
        "heartbeatMs": 2000
      }
    }
  ]
}
```

### 3. Play

Start `opencode` in your terminal:

- `/subway` — toggle Subway Surfers ON / OFF
- `/subway on` — launch the Subway Surfers window and enable auto-pause
- `/subway off` — close the Subway Surfers window
- Override the target web game URL anytime with `SUBWAY_URL="..."` (or `SUBWAY_APP_BIN="..."` for a custom binary path).

## Development

```sh
npm install
npm run build --workspace opencode-subway-surfers
npm run dev          # run the Tauri wrapper in dev mode
npm test             # run wrapper + tracker tests
npm run typecheck
```

Test agent states manually without OpenCode:

```sh
npm run mock waiting
npm run mock working
npm run mock shell
```
