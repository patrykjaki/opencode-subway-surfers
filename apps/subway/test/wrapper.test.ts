import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const WRAPPER_SOURCE = readFileSync(
  resolve(import.meta.dirname, "../src-tauri/src/wrapper.js"),
  "utf8",
)

interface HarnessOptions {
  hostname?: string
  isTop?: boolean
  cookieBannerVisible?: boolean
  gameIframePresent?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const hostname = options.hostname ?? "poki.com"
  const isTop = options.isTop ?? true
  let cookieBannerVisible = options.cookieBannerVisible ?? false
  let gameIframePresent = options.gameIframePresent ?? true

  let nowMs = 1_000
  let rafIdCounter = 100
  const rafQueue = new Map<number, (ts: number) => void>()
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const postedToTop: unknown[] = []
  const postedToChild: unknown[] = []

  class FakeAudioContext {
    state: "running" | "suspended" = "running"
    suspend = vi.fn(async () => {
      this.state = "suspended"
    })
    resume = vi.fn(async () => {
      this.state = "running"
    })
  }

  const fakeShadowElements = new Map<
    string,
    {
      id: string
      className: string
      textContent: string
      style: Record<string, string>
      listeners: Map<string, (e: { stopPropagation: () => void; preventDefault: () => void }) => void>
      addEventListener: (
        type: string,
        fn: (e: { stopPropagation: () => void; preventDefault: () => void }) => void,
      ) => void
      click: () => void
    }
  >()

  const getEl = (id: string) => {
    if (!fakeShadowElements.has(id)) {
      const elListeners = new Map<
        string,
        (e: { stopPropagation: () => void; preventDefault: () => void }) => void
      >()
      fakeShadowElements.set(id, {
        id,
        className: "",
        textContent: "",
        style: {},
        listeners: elListeners,
        addEventListener: (type, fn) => {
          elListeners.set(type, fn)
        },
        click: () => {
          const fn = elListeners.get("click")
          fn?.({ stopPropagation: vi.fn(), preventDefault: vi.fn() })
        },
      })
    }
    return fakeShadowElements.get(id)!
  }

  const hostAttrs = new Map<string, string>()
  const hostEl = {
    id: "subway-autopause-host",
    isConnected: true,
    style: { cssText: "" },
    shadowRoot: null as unknown,
    setAttribute: (k: string, v: string) => hostAttrs.set(k, v),
    getAttribute: (k: string) => hostAttrs.get(k) ?? null,
    matches: () => true,
    showPopover: vi.fn(),
    attachShadow() {
      const shadow = {
        innerHTML: "",
        getElementById: getEl,
      }
      this.shadowRoot = shadow
      return shadow
    },
  }

  const childIframe = {
    id: "game-element",
    src: "https://games.poki-gdn.com/subway-surfers/index.html",
    attrs: new Map<string, string>(),
    getAttribute(k: string) {
      return this.attrs.get(k) ?? (k === "src" ? this.src : null)
    },
    setAttribute(k: string, v: string) {
      this.attrs.set(k, v)
    },
    removeAttribute(k: string) {
      this.attrs.delete(k)
    },
    hasAttribute: (k: string) => k === "allowfullscreen",
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    contentWindow: {
      postMessage: (msg: unknown) => postedToChild.push(msg),
    },
  }

  const cookieEl = {
    getBoundingClientRect: () => ({ width: 500, height: 400 }),
  }

  const storage = new Map<string, string>()

  const contextObj: Record<string, unknown> = {
    Date: { now: () => nowMs },
    Math,
    Map,
    Set,
    Array,
    Number,
    String,
    Boolean,
    Object,
    WeakRef,
    Proxy,
    Reflect,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: {
      now: () => nowMs,
    },
    AudioContext: FakeAudioContext,
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
    location: { hostname },
    requestAnimationFrame: (cb: (ts: number) => void) => {
      const id = rafIdCounter++
      rafQueue.set(id, cb)
      return id
    },
    cancelAnimationFrame: (id: number) => {
      rafQueue.delete(id)
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    document: {
      readyState: "complete",
      head: { appendChild: vi.fn() },
      documentElement: { appendChild: vi.fn() },
      body: {},
      getElementById: () => null,
      createElement: () => hostEl,
      querySelector: (sel: string) => {
        if (cookieBannerVisible && sel.includes("fc-consent-root")) return cookieEl
        return null
      },
      querySelectorAll: (sel: string) => {
        if (sel === "iframe") return gameIframePresent ? [childIframe] : []
        return []
      },
      addEventListener: vi.fn(),
    },
  }

  contextObj.window = contextObj
  contextObj.top = isTop
    ? contextObj
    : {
        postMessage: (msg: unknown) => postedToTop.push(msg),
      }

  vm.runInNewContext(WRAPPER_SOURCE, contextObj)

  return {
    win: contextObj as Record<string, any>,
    postedToTop,
    postedToChild,
    getShadowEl: getEl,
    setCookieBannerVisible: (v: boolean) => {
      cookieBannerVisible = v
    },
    setGameIframePresent: (v: boolean) => {
      gameIframePresent = v
    },
    advanceTime: (ms: number) => {
      nowMs += ms
      vi.advanceTimersByTime(ms)
    },
    flushRaf: () => {
      const items = Array.from(rafQueue.entries())
      rafQueue.clear()
      for (const [, cb] of items) cb(nowMs)
    },
    dispatchMessage: (data: unknown) => {
      for (const fn of listeners.get("message") ?? []) {
        fn({ data })
      }
    },
  }
}

describe("wrapper.js", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("freezes rAF, virtualizes performance.now, and suspends AudioContext in game frames", () => {
    const h = createHarness({ hostname: "games.poki-gdn.com", isTop: false })
    expect(h.postedToTop).toContainEqual({
      source: "opencode-subway-surfers",
      type: "frame-ready",
    })

    const audio = new h.win.AudioContext()
    let frames = 0
    let lastTs = 0
    const tick = (ts: number) => {
      frames += 1
      lastTs = ts
      h.win.requestAnimationFrame(tick)
    }

    h.win.requestAnimationFrame(tick)
    h.flushRaf()
    expect(frames).toBe(1)
    expect(lastTs).toBe(1_000)

    h.dispatchMessage({
      source: "opencode-subway-surfers",
      type: "set-paused",
      paused: true,
    })
    expect(audio.suspend).toHaveBeenCalledTimes(1)
    expect(h.win.performance.now()).toBe(1_000)

    h.advanceTime(5_000)
    h.flushRaf()
    expect(frames).toBe(1)
    expect(h.win.performance.now()).toBe(1_000)

    h.dispatchMessage({
      source: "opencode-subway-surfers",
      type: "set-paused",
      paused: false,
    })
    expect(audio.resume).toHaveBeenCalledTimes(1)
    expect(h.win.performance.now()).toBe(1_000)

    h.advanceTime(16)
    h.flushRaf()
    expect(frames).toBe(2)
    expect(lastTs).toBe(1_016)
  })

  it("does not block Poki cookie consent before game iframe is interactive", () => {
    const h = createHarness({
      hostname: "poki.com",
      isTop: true,
      cookieBannerVisible: true,
      gameIframePresent: false,
    })
    const api = h.win.__SUBWAY_WRAPPER__

    api.onAgentState({ phase: "waiting", reason: "idle" })
    expect(api.getState().gameReady).toBe(false)
    expect(api.getState().status).toBe("playing")

    // User accepts cookies and game iframe mounts -> auto-pause activates
    h.setCookieBannerVisible(false)
    h.setGameIframePresent(true)
    h.advanceTime(600)
    expect(api.getState().gameReady).toBe(true)
    expect(api.getState().status).toBe("auto-paused")
  })

  it("handles overlay resume button clicks and countdown on working", () => {
    const h = createHarness({ hostname: "poki.com", isTop: true })
    const api = h.win.__SUBWAY_WRAPPER__

    api.onAgentState({ phase: "waiting", reason: "idle" })
    expect(api.getState().status).toBe("auto-paused")

    // Clicking "Resume anyway" snoozes and unfreezes immediately
    h.getShadowEl("btn-resume-anyway").click()
    expect(api.getState().status).toBe("playing")
    expect(api.getState().snoozed).toBe(true)

    // Next working -> waiting cycle re-arms auto-pause
    api.onAgentState({ phase: "working", reason: "execution" })
    api.onAgentState({ phase: "waiting", reason: "idle" })
    expect(api.getState().status).toBe("auto-paused")

    // Agent works -> 3s (3 * 1000ms) countdown -> playing
    api.onAgentState({ phase: "working", reason: "execution" })
    expect(api.getState().status).toBe("countdown")
    h.advanceTime(2_500)
    expect(api.getState().status).toBe("countdown")
    h.advanceTime(500)
    expect(api.getState().status).toBe("playing")
  })

  it("respects manual pause and 6s fail-open", () => {
    const h = createHarness({ hostname: "poki.com", isTop: true })
    const api = h.win.__SUBWAY_WRAPPER__

    api.toggleManualPause()
    expect(api.getState().status).toBe("manual-paused")
    api.onAgentState({ phase: "working", reason: "execution" })
    expect(api.getState().status).toBe("manual-paused")
    api.toggleManualPause()
    expect(api.getState().status).toBe("playing")

    api.onAgentState({ phase: "waiting", reason: "idle" })
    expect(api.getState().status).toBe("auto-paused")
    h.advanceTime(6_500)
    expect(api.getState().status).toBe("playing")
    expect(api.getState().agentPhase).toBe("offline")
  })
})
