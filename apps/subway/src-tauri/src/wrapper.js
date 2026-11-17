(() => {
  if (window.__SUBWAY_WRAPPER_LOADED__) return;
  window.__SUBWAY_WRAPPER_LOADED__ = true;

  const MSG_SOURCE = "opencode-subway-surfers";
  const STALE_MS = 6_000;
  const COUNTDOWN_STEPS = 3;
  const COUNTDOWN_STEP_MS = 1000;
  const AUTO_PAUSE_STORAGE_KEY = "subway_autopause_enabled";
  const THEATER_STORAGE_KEY = "subway_theater_mode";

  const isTop = (() => {
    try {
      return window === window.top;
    } catch {
      return false;
    }
  })();

  const isPokiPortal = isTop && /(^|\.)poki\.com$/i.test(window.location.hostname || "");
  const shouldHookGameLoop = !isPokiPortal;

  // ---------------------------------------------------------------------------
  // 1. Game loop + audio freeze shim (runs in child iframes & standalone URLs)
  // ---------------------------------------------------------------------------
  const realPerfNow =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now.bind(performance)
      : () => Date.now();

  let gameFrozen = false;
  let pauseStartedAt = 0;
  let totalPausedMs = 0;

  const activeRafs = new Map();
  const pausedRafs = new Map();
  let nextRafId = 1;

  function dispatchDebugClick(data) {
    const target = document.querySelector("canvas") || document.body;
    if (!target) return;
    const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0 };
    const x = rect.left + Number(data.x || 0);
    const y = rect.top + Number(data.y || 0);
    if (typeof target.focus === "function") target.focus();
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      view: window,
      button: 0,
      detail: 1,
    };
    const pointer = {
      ...base,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 1,
    };
    const steps = [
      ["pointerdown", PointerEvent, pointer],
      ["mousedown", MouseEvent, base],
      ["pointerup", PointerEvent, { ...pointer, buttons: 0 }],
      ["mouseup", MouseEvent, { ...base, buttons: 0 }],
      ["click", MouseEvent, { ...base, buttons: 0 }],
    ];
    for (const [type, Ctor, init] of steps) {
      try {
        target.dispatchEvent(new Ctor(type, init));
      } catch {
        // Debug helper; ignore unsupported event types.
      }
    }
  }

  const trackedAudioContexts = new Set();
  const suspendedAudioContexts = new Set();
  const pausedMediaElements = new Set();

  function virtualNow() {
    const base = gameFrozen ? pauseStartedAt : realPerfNow();
    return Math.max(0, base - totalPausedMs);
  }

  function forwardPauseToChildFrames(paused) {
    try {
      const frames = document.querySelectorAll("iframe");
      for (const frame of frames) {
        try {
          frame.contentWindow?.postMessage(
            { source: MSG_SOURCE, type: "set-paused", paused },
            "*",
          );
        } catch {
          // Cross-origin frame errors are ignored; postMessage with '*' is allowed.
        }
      }
    } catch {
      // Ignore DOM query issues during early document_start.
    }
  }

  function suspendAudio() {
    for (const ref of Array.from(trackedAudioContexts)) {
      const ctx = ref.deref();
      if (!ctx) {
        trackedAudioContexts.delete(ref);
        continue;
      }
      if (ctx.state === "running" && typeof ctx.suspend === "function") {
        suspendedAudioContexts.add(ctx);
        ctx.suspend().catch(() => {});
      }
    }

    try {
      const media = document.querySelectorAll("audio, video");
      for (const el of media) {
        if (!el.paused && typeof el.pause === "function") {
          pausedMediaElements.add(el);
          el.pause();
        }
      }
    } catch {
      // Ignore if document is not ready yet.
    }
  }

  function resumeAudio() {
    for (const ctx of Array.from(suspendedAudioContexts)) {
      suspendedAudioContexts.delete(ctx);
      if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        ctx.resume().catch(() => {});
      }
    }

    for (const el of Array.from(pausedMediaElements)) {
      pausedMediaElements.delete(el);
      if (el.isConnected && el.paused && typeof el.play === "function") {
        el.play().catch(() => {});
      }
    }
  }

  let realRAF = null;
  let realCAF = null;

  function setGameFrozen(nextPaused) {
    forwardPauseToChildFrames(nextPaused);

    if (!shouldHookGameLoop) return;
    if (nextPaused === gameFrozen) return;

    if (nextPaused) {
      gameFrozen = true;
      pauseStartedAt = realPerfNow();
      suspendAudio();
    } else {
      if (pauseStartedAt > 0) {
        totalPausedMs += Math.max(0, realPerfNow() - pauseStartedAt);
      }
      pauseStartedAt = 0;
      gameFrozen = false;
      resumeAudio();

      if (realRAF) {
        const queued = Array.from(pausedRafs.entries());
        pausedRafs.clear();
        for (const [id, cb] of queued) {
          const realId = realRAF((realTs) => {
            activeRafs.delete(id);
            if (gameFrozen) {
              pausedRafs.set(id, cb);
              return;
            }
            cb(Math.max(0, realTs - totalPausedMs));
          });
          activeRafs.set(id, realId);
        }
      }
    }
  }

  if (shouldHookGameLoop && typeof window.requestAnimationFrame === "function") {
    realRAF = window.requestAnimationFrame.bind(window);
    realCAF = window.cancelAnimationFrame.bind(window);

    try {
      Object.defineProperty(performance, "now", {
        configurable: true,
        writable: true,
        value: () => virtualNow(),
      });
    } catch {
      try {
        performance.now = () => virtualNow();
      } catch {
        // Ignore if non-writable in test environments.
      }
    }

    window.requestAnimationFrame = (callback) => {
      if (typeof callback !== "function") return 0;
      const id = nextRafId++;
      if (gameFrozen) {
        pausedRafs.set(id, callback);
        return id;
      }
      const realId = realRAF((realTs) => {
        activeRafs.delete(id);
        if (gameFrozen) {
          pausedRafs.set(id, callback);
          return;
        }
        callback(Math.max(0, realTs - totalPausedMs));
      });
      activeRafs.set(id, realId);
      return id;
    };

    window.cancelAnimationFrame = (id) => {
      pausedRafs.delete(id);
      const realId = activeRafs.get(id);
      if (realId !== undefined) {
        activeRafs.delete(id);
        realCAF(realId);
      }
    };

    const wrapAudioCtor = (Ctor) => {
      if (typeof Ctor !== "function") return Ctor;
      return new Proxy(Ctor, {
        construct(target, args, newTarget) {
          const ctx = Reflect.construct(target, args, newTarget);
          trackedAudioContexts.add(new WeakRef(ctx));
          if (gameFrozen && ctx && typeof ctx.suspend === "function") {
            suspendedAudioContexts.add(ctx);
            ctx.suspend().catch(() => {});
          }
          return ctx;
        },
      });
    };

    if (typeof window.AudioContext === "function") {
      window.AudioContext = wrapAudioCtor(window.AudioContext);
    }
    if (typeof window.webkitAudioContext === "function") {
      window.webkitAudioContext = wrapAudioCtor(window.webkitAudioContext);
    }
  }

  if (!isTop) {
    window.addEventListener("message", (event) => {
      const data = event?.data;
      if (!data || data.source !== MSG_SOURCE) return;
      if (data.type === "set-paused") {
        setGameFrozen(Boolean(data.paused));
        return;
      }
      if (data.type === "debug-click" && window.__SUBWAY_DEBUG__) {
        dispatchDebugClick(data);
      }
    });

    const notifyReady = () => {
      try {
        window.top?.postMessage({ source: MSG_SOURCE, type: "frame-ready" }, "*");
      } catch {
        // Ignore cross-origin postMessage restrictions.
      }
    };
    notifyReady();
    window.addEventListener("DOMContentLoaded", notifyReady);
    window.addEventListener("load", notifyReady);
    return;
  }

  // ---------------------------------------------------------------------------
  // 2. Poki portal helpers (cookie banner detection & clean game focus mode)
  // ---------------------------------------------------------------------------
  function findPokiGameIframe() {
    if (!isPokiPortal) return null;
    try {
      const frames = Array.from(document.querySelectorAll("iframe"));
      let best = null;
      let bestArea = 0;
      for (const frame of frames) {
        const src = String(frame.getAttribute("src") || frame.src || "");
        if (/doubleclick|googlesyndication|fundingchoices|consent|privacy|cmp/i.test(src)) continue;
        const rect = frame.getBoundingClientRect ? frame.getBoundingClientRect() : null;
        const w = rect ? rect.width : Number(frame.clientWidth || 0);
        const h = rect ? rect.height : Number(frame.clientHeight || 0);
        const area = w * h;
        const looksLikeGame =
          frame.id === "game-element" ||
          /poki-gdn|games\.poki|subway/i.test(src) ||
          frame.hasAttribute("allowfullscreen");
        if (w >= 240 && h >= 240 && (looksLikeGame || area > bestArea)) {
          best = frame;
          bestArea = area;
          if (looksLikeGame) break;
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  function hasVisibleCookieModal(gameFrame) {
    if (!isPokiPortal) return false;
    try {
      const selectors = [
        ".fc-consent-root",
        "#didomi-host",
        "#onetrust-consent-sdk",
        ".qc-cmp2-container",
        "[aria-modal='true']",
        "dialog[open]",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (ui && el === ui.host) continue;
        if (el.getBoundingClientRect) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 50) return true;
        } else {
          return true;
        }
      }

      // Check whether a modal/overlay sits above the game iframe at viewport center
      if (
        gameFrame &&
        typeof document.elementFromPoint === "function" &&
        (!ui || state.status === "playing")
      ) {
        const rect = gameFrame.getBoundingClientRect ? gameFrame.getBoundingClientRect() : null;
        const cx = rect && rect.width > 0 ? rect.left + rect.width / 2 : (window.innerWidth || 800) / 2;
        const cy = rect && rect.height > 0 ? rect.top + rect.height / 2 : (window.innerHeight || 600) / 2;
        const topEl = document.elementFromPoint(cx, cy);
        if (topEl && topEl !== gameFrame && (!ui || topEl !== ui.host)) {
          return true;
        }
      }
    } catch {
      // Ignore DOM access issues.
    }
    return false;
  }

  function isGameInteractive() {
    if (!isPokiPortal) {
      try {
        return Boolean(document.querySelector("canvas"));
      } catch {
        return true;
      }
    }
    const frame = findPokiGameIframe();
    if (!frame) return false;
    if (hasVisibleCookieModal(frame)) return false;
    return true;
  }

  function readStoredBool(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return fallback;
      return raw !== "false";
    } catch {
      return fallback;
    }
  }

  function writeStoredBool(key, value) {
    try {
      window.localStorage.setItem(key, value ? "true" : "false");
    } catch {
      // Ignore storage failures.
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Top-frame controller, state machine & floating HUD
  // ---------------------------------------------------------------------------
  const state = {
    status: "playing", // "playing" | "auto-paused" | "manual-paused" | "countdown"
    autoPauseEnabled: readStoredBool(AUTO_PAUSE_STORAGE_KEY, true),
    theaterEnabled: readStoredBool(THEATER_STORAGE_KEY, true),
    snoozed: false,
    agentPhase: "unknown", // "unknown" | "working" | "waiting" | "offline"
    agentReason: "startup",
    pendingPermissions: 0,
    runningShells: 0,
    lastReceivedAt: 0,
    countdownValue: COUNTDOWN_STEPS,
    minimized: false,
    gameReady: !isPokiPortal,
  };

  let countdownTimer = null;
  let theaterStyleEl = null;

  const THEATER_HIDDEN_CLASS = "subway-theater-hidden";

  function hideTheaterSiblings(frame) {
    const keep = new Set();
    let node = frame;
    while (node && node !== document.body && node.parentElement) {
      keep.add(node);
      for (const child of Array.from(node.parentElement.children ?? [])) {
        if (child !== node && child.classList) child.classList.add(THEATER_HIDDEN_CLASS);
      }
      node = node.parentElement;
    }
    const body = document.body;
    if (body && body.children) {
      for (const child of Array.from(body.children)) {
        if (!keep.has(child) && child.classList) child.classList.add(THEATER_HIDDEN_CLASS);
      }
    }
  }

  function clearTheaterSiblings() {
    if (typeof document.querySelectorAll !== "function") return;
    for (const el of Array.from(document.querySelectorAll(`.${THEATER_HIDDEN_CLASS}`))) {
      if (el.classList) el.classList.remove(THEATER_HIDDEN_CLASS);
    }
  }

  function injectHostCleanupCSS() {
    if (isPokiPortal || !document.head && !document.documentElement) return;
    if (document.getElementById("subway-host-cleanup")) return;
    try {
      const style = document.createElement("style");
      style.id = "subway-host-cleanup";
      style.textContent = `
        #staticMenu,
        #staticSlideMenu,
        .static-menu,
        #switchBtn,
        .seo-hidden {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    } catch {
      // Ignore early DOM mount failures.
    }
  }

  function applyTheaterMode() {
    injectHostCleanupCSS();
    if (!isPokiPortal || (!document.head && !document.documentElement)) return;
    const frame = findPokiGameIframe();
    const active = state.theaterEnabled && state.gameReady && Boolean(frame);

    if (active && frame) {
      if (!theaterStyleEl) {
        theaterStyleEl = document.createElement("style");
        theaterStyleEl.id = "subway-theater-style";
        theaterStyleEl.textContent = `
          html, body {
            overflow: hidden !important;
            background: #0b1120 !important;
          }
          iframe[data-subway-theater="1"] {
            position: fixed !important;
            inset: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            max-width: none !important;
            max-height: none !important;
            border: 0 !important;
            z-index: 2147483000 !important;
            background: #000 !important;
          }
          .${THEATER_HIDDEN_CLASS} {
            visibility: hidden !important;
            pointer-events: none !important;
          }
        `;
        (document.head || document.documentElement).appendChild(theaterStyleEl);
      }
      if (frame.getAttribute("data-subway-theater") !== "1") {
        frame.setAttribute("data-subway-theater", "1");
      }
      hideTheaterSiblings(frame);
    } else {
      if (frame && frame.getAttribute("data-subway-theater") === "1") {
        frame.removeAttribute("data-subway-theater");
      }
      if (theaterStyleEl && theaterStyleEl.parentNode) {
        theaterStyleEl.parentNode.removeChild(theaterStyleEl);
        theaterStyleEl = null;
      }
      clearTheaterSiblings();
    }
  }

  function clearCountdown() {
    if (countdownTimer !== null) {
      clearTimeout(countdownTimer);
      countdownTimer = null;
    }
  }

  function shouldGameBeFrozen() {
    return state.status !== "playing";
  }

  function syncGamePause() {
    setGameFrozen(shouldGameBeFrozen());
    render();
  }

  function startCountdown() {
    clearCountdown();
    state.status = "countdown";
    state.countdownValue = COUNTDOWN_STEPS;
    syncGamePause();

    const tick = () => {
      if (state.status !== "countdown") return;
      if (state.countdownValue <= 1) {
        countdownTimer = null;
        state.status = "playing";
        syncGamePause();
        return;
      }
      state.countdownValue -= 1;
      render();
      countdownTimer = setTimeout(tick, COUNTDOWN_STEP_MS);
    };

    countdownTimer = setTimeout(tick, COUNTDOWN_STEP_MS);
  }

  function evaluateAgentState() {
    state.gameReady = isGameInteractive();
    applyTheaterMode();

    const stale =
      state.lastReceivedAt > 0 && Date.now() - state.lastReceivedAt > STALE_MS;

    if (stale) {
      state.agentPhase = "offline";
      state.agentReason = "timeout";
    }

    if (state.status === "manual-paused") {
      render();
      return;
    }

    if (state.status === "auto-paused") {
      if (stale || state.agentPhase === "offline" || !state.gameReady) {
        clearCountdown();
        state.status = "playing";
        syncGamePause();
        return;
      }
      if (state.agentPhase === "working") {
        startCountdown();
        return;
      }
      render();
      return;
    }

    if (state.status === "countdown") {
      if (
        !stale &&
        state.gameReady &&
        state.autoPauseEnabled &&
        !state.snoozed &&
        state.agentPhase === "waiting"
      ) {
        clearCountdown();
        state.status = "auto-paused";
        syncGamePause();
        return;
      }
      render();
      return;
    }

    // status === "playing"
    if (
      !stale &&
      state.gameReady &&
      state.autoPauseEnabled &&
      !state.snoozed &&
      state.agentPhase === "waiting"
    ) {
      state.status = "auto-paused";
      syncGamePause();
      return;
    }

    render();
  }

  function onAgentState(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    const phase = snapshot.phase;
    if (phase !== "working" && phase !== "waiting" && phase !== "offline") return;

    state.agentPhase = phase;
    state.agentReason = typeof snapshot.reason === "string" ? snapshot.reason : "idle";
    state.pendingPermissions = Number(snapshot.sessions?.pendingPermissions ?? 0) || 0;
    state.runningShells = Number(snapshot.shells?.running ?? 0) || 0;
    state.lastReceivedAt = Date.now();

    if (phase === "working") {
      state.snoozed = false;
    }

    evaluateAgentState();
  }

  function toggleManualPause() {
    clearCountdown();
    if (state.status === "manual-paused") {
      state.status = "playing";
    } else if (state.status === "auto-paused") {
      state.snoozed = true;
      state.status = "playing";
    } else {
      state.status = "manual-paused";
    }
    syncGamePause();
  }

  function resumeFromAutoPause() {
    if (state.status !== "auto-paused") return;
    state.snoozed = true;
    state.status = "playing";
    syncGamePause();
  }

  function toggleAutoPause() {
    state.autoPauseEnabled = !state.autoPauseEnabled;
    writeStoredBool(AUTO_PAUSE_STORAGE_KEY, state.autoPauseEnabled);
    if (!state.autoPauseEnabled && (state.status === "auto-paused" || state.status === "countdown")) {
      clearCountdown();
      state.status = "playing";
      syncGamePause();
      return;
    }
    evaluateAgentState();
  }

  function toggleTheaterMode() {
    state.theaterEnabled = !state.theaterEnabled;
    writeStoredBool(THEATER_STORAGE_KEY, state.theaterEnabled);
    applyTheaterMode();
    render();
  }

  // Listen for child iframes announcing readiness
  window.addEventListener("message", (event) => {
    const data = event?.data;
    if (!data || data.source !== MSG_SOURCE) return;
    if (data.type === "frame-ready") {
      evaluateAgentState();
      forwardPauseToChildFrames(shouldGameBeFrozen());
    }
  });

  // Periodic watchdog: Poki iframe/cookie state, stale fail-open, iframe pause keep-alive
  setInterval(() => {
    const prevReady = state.gameReady;
    const nextReady = isGameInteractive();
    if (prevReady !== nextReady) {
      evaluateAgentState();
    } else {
      applyTheaterMode();
    }

    if (
      state.status === "auto-paused" &&
      state.lastReceivedAt > 0 &&
      Date.now() - state.lastReceivedAt > STALE_MS
    ) {
      evaluateAgentState();
    }
    if (shouldGameBeFrozen()) {
      forwardPauseToChildFrames(true);
    }
  }, 500);

  // ---------------------------------------------------------------------------
  // 4. Shadow DOM HUD + Pause Overlay (window-capture immune to CMP traps!)
  // ---------------------------------------------------------------------------
  let ui = null;
  let lastActionAt = 0;

  function runButtonAction(el) {
    const now = Date.now();
    if (now - lastActionAt < 180) return;
    lastActionAt = now;

    if (el === ui?.btnResumeAnyway) {
      if (state.status === "manual-paused") {
        toggleManualPause();
      } else {
        resumeFromAutoPause();
      }
    } else if (el === ui?.btnToggleAutoOverlay || el === ui?.btnAuto) {
      toggleAutoPause();
    } else if (el === ui?.btnTheater) {
      toggleTheaterMode();
    } else if (el === ui?.btnPause) {
      toggleManualPause();
    } else if (el === ui?.btnMin) {
      state.minimized = !state.minimized;
      render();
    }
  }

  // Register at document_start in window capture phase so Poki/CMP modal traps
  // can never swallow pointer/click events aimed at our HUD or overlay.
  const captureEvents = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const eventName of captureEvents) {
    window.addEventListener(
      eventName,
      (event) => {
        if (!ui || !ui.host) return;
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        if (!path.includes(ui.host)) return;

        event.stopImmediatePropagation();
        event.preventDefault();

        if (eventName === "pointerdown" || eventName === "click") {
          const buttons = [
            ui.btnResumeAnyway,
            ui.btnToggleAutoOverlay,
            ui.btnAuto,
            ui.btnTheater,
            ui.btnPause,
            ui.btnMin,
          ];
          for (const btn of buttons) {
            if (btn && path.includes(btn)) {
              runButtonAction(btn);
              break;
            }
          }
        }
      },
      true,
    );
  }

  function updateHostLayout(host, overlayOpen) {
    if (overlayOpen) {
      host.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;pointer-events:auto;z-index:2147483647;max-width:none;max-height:none;overflow:visible;";
    } else {
      host.style.cssText =
        "position:fixed;left:14px;bottom:14px;top:auto;right:auto;width:max-content;height:max-content;margin:0;padding:0;border:0;background:transparent;pointer-events:auto;z-index:2147483647;max-width:none;max-height:none;overflow:visible;";
    }
  }

  function promoteToTopLayer(host) {
    try {
      if (typeof host.showPopover === "function") {
        if (host.getAttribute("popover") !== "manual") {
          host.setAttribute("popover", "manual");
        }
        if (!host.matches(":popover-open")) {
          host.showPopover();
        }
      }
    } catch {
      // Popover API not supported or element not in document yet.
    }
  }

  function bindTap(el) {
    const run = (event) => {
      event.stopPropagation();
      event.preventDefault();
      runButtonAction(el);
    };
    el.addEventListener("pointerdown", run);
    el.addEventListener("click", run);
  }

  function ensureUI() {
    if (!document.body || !document.documentElement) return null;
    if (ui && ui.host.isConnected) {
      promoteToTopLayer(ui.host);
      return ui;
    }

    let host = document.getElementById("subway-autopause-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "subway-autopause-host";
      document.documentElement.appendChild(host);
    }

    updateHostLayout(host, false);
    promoteToTopLayer(host);

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .overlay {
          position: fixed;
          inset: 0;
          background: rgba(9, 13, 24, 0.74);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          display: none;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
          z-index: 10;
        }
        .overlay.visible { display: flex; }
        .card {
          max-width: 380px;
          width: calc(100% - 40px);
          background: rgba(18, 24, 38, 0.96);
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 18px;
          padding: 24px;
          color: #f4f7fb;
          text-align: center;
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          background: rgba(245, 158, 11, 0.18);
          color: #fbbf24;
          margin-bottom: 12px;
        }
        .badge.working {
          background: rgba(34, 197, 94, 0.18);
          color: #4ade80;
        }
        .title {
          margin: 0 0 8px;
          font-size: 22px;
          font-weight: 800;
          letter-spacing: -0.02em;
        }
        .subtitle {
          margin: 0 0 18px;
          font-size: 13.5px;
          line-height: 1.45;
          color: #b5c0d4;
        }
        .countdown-num {
          font-size: 64px;
          font-weight: 900;
          line-height: 1;
          margin: 8px 0 12px;
          color: #4ade80;
        }
        .actions {
          display: flex;
          gap: 10px;
          justify-content: center;
          flex-wrap: wrap;
        }
        button {
          font: inherit;
          border: none;
          cursor: pointer;
          border-radius: 10px;
          padding: 9px 14px;
          font-size: 13px;
          font-weight: 600;
          transition: transform 0.1s ease, background 0.15s ease;
        }
        button:active { transform: scale(0.97); }
        .btn-primary {
          background: #38bdf8;
          color: #081220;
        }
        .btn-primary:hover { background: #7dd3fc; }
        .btn-ghost {
          background: rgba(255, 255, 255, 0.12);
          color: #e2e8f0;
        }
        .btn-ghost:hover { background: rgba(255, 255, 255, 0.2); }

        .hud {
          position: fixed;
          bottom: 12px;
          left: 12px;
          max-width: calc(100vw - 24px);
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(13, 19, 33, 0.88);
          border: 1px solid rgba(255, 255, 255, 0.16);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          color: #f1f5f9;
          font-size: 11.5px;
          font-weight: 600;
          white-space: nowrap;
          pointer-events: auto;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
          z-index: 20;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex: 0 0 auto;
          background: #94a3b8;
        }
        .dot.working { background: #4ade80; box-shadow: 0 0 8px #4ade80; }
        .dot.waiting { background: #fbbf24; box-shadow: 0 0 8px #fbbf24; }
        .dot.offline { background: #64748b; }
        .hud-btn {
          padding: 4px 8px;
          border-radius: 999px;
          font-size: 11px;
          background: rgba(255, 255, 255, 0.12);
          color: #e2e8f0;
        }
        .hud-btn:hover { background: rgba(255, 255, 255, 0.22); }
        .hud-btn.active {
          background: rgba(56, 189, 248, 0.26);
          color: #7dd3fc;
        }
        .hud.minimized .hud-extra { display: none; }
      </style>

      <div id="overlay" class="overlay">
        <div class="card">
          <div id="badge" class="badge">PAUSED</div>
          <h2 id="title" class="title">Agent waiting for prompt</h2>
          <div id="countdown" class="countdown-num" style="display:none">3</div>
          <p id="subtitle" class="subtitle"></p>
          <div id="actions" class="actions">
            <button id="btn-resume-anyway" class="btn-primary">Resume</button>
            <button id="btn-toggle-auto-overlay" class="btn-ghost">Disable auto-pause</button>
          </div>
        </div>
      </div>

      <div id="hud" class="hud">
        <span id="dot" class="dot"></span>
        <span id="status-text">OpenCode…</span>
        <button id="btn-auto" class="hud-btn hud-extra" title="Auto-pause while agent waits">Auto</button>
        <button id="btn-theater" class="hud-btn hud-extra" title="Expand game to full window">Focus</button>
        <button id="btn-pause" class="hud-btn hud-extra" title="Pause / Resume (Cmd+Shift+P)">⏸</button>
        <button id="btn-min" class="hud-btn" title="Collapse / Expand">—</button>
      </div>
    `;

    const refs = {
      host,
      overlay: shadow.getElementById("overlay"),
      badge: shadow.getElementById("badge"),
      title: shadow.getElementById("title"),
      countdown: shadow.getElementById("countdown"),
      subtitle: shadow.getElementById("subtitle"),
      actions: shadow.getElementById("actions"),
      btnResumeAnyway: shadow.getElementById("btn-resume-anyway"),
      btnToggleAutoOverlay: shadow.getElementById("btn-toggle-auto-overlay"),
      hud: shadow.getElementById("hud"),
      dot: shadow.getElementById("dot"),
      statusText: shadow.getElementById("status-text"),
      btnAuto: shadow.getElementById("btn-auto"),
      btnTheater: shadow.getElementById("btn-theater"),
      btnPause: shadow.getElementById("btn-pause"),
      btnMin: shadow.getElementById("btn-min"),
    };

    bindTap(refs.btnResumeAnyway);
    bindTap(refs.btnToggleAutoOverlay);
    bindTap(refs.btnAuto);
    bindTap(refs.btnTheater);
    bindTap(refs.btnPause);
    bindTap(refs.btnMin);

    ui = refs;
    return ui;
  }

  function statusLabel() {
    if (!state.gameReady && isPokiPortal) {
      return state.agentPhase === "working"
        ? "Start game (agent working)"
        : "Start the game on page";
    }
    if (state.agentPhase === "working") {
      return state.runningShells > 0
        ? `Agent working (shell: ${state.runningShells})`
        : "Agent working";
    }
    if (state.agentPhase === "waiting") {
      if (state.agentReason === "permission") return "Agent waiting (permission)";
      if (state.snoozed) return "Agent waiting (snoozed)";
      return "Agent waiting — PAUSED";
    }
    if (state.agentPhase === "offline") return "Agent offline";
    return "Waiting for OpenCode…";
  }

  function render() {
    const refs = ensureUI();
    if (!refs) return;

    const overlayOpen = state.status !== "playing";
    updateHostLayout(refs.host, overlayOpen);
    promoteToTopLayer(refs.host);

    refs.dot.className = `dot ${state.agentPhase}`;
    refs.statusText.textContent = statusLabel();
    refs.btnAuto.textContent = state.autoPauseEnabled ? "Auto: ON" : "Auto: OFF";
    refs.btnAuto.className = `hud-btn hud-extra ${state.autoPauseEnabled ? "active" : ""}`;
    refs.btnTheater.style.display = isPokiPortal ? "inline-block" : "none";
    refs.btnTheater.textContent = state.theaterEnabled ? "Focus: ON" : "Focus: OFF";
    refs.btnTheater.className = `hud-btn hud-extra ${state.theaterEnabled ? "active" : ""}`;
    refs.btnPause.textContent = state.status === "playing" ? "⏸" : "▶";
    refs.hud.className = `hud ${state.minimized ? "minimized" : ""}`;
    refs.btnMin.textContent = state.minimized ? "+" : "—";

    if (!overlayOpen) {
      refs.overlay.className = "overlay";
      return;
    }

    refs.overlay.className = "overlay visible";
    if (state.status === "countdown") {
      refs.badge.className = "badge working";
      refs.badge.textContent = "AGENT WORKING";
      refs.title.textContent = "Resuming game…";
      refs.countdown.style.display = "block";
      refs.countdown.textContent = String(state.countdownValue);
      refs.subtitle.textContent = "Hands on the arrow keys!";
      refs.actions.style.display = "none";
      return;
    }

    refs.countdown.style.display = "none";
    refs.actions.style.display = "flex";

    if (state.status === "manual-paused") {
      refs.badge.className = "badge";
      refs.badge.textContent = "MANUAL PAUSE";
      refs.title.textContent = "Game paused";
      refs.subtitle.textContent = "Manual pause won't be lifted automatically by the agent.";
      refs.btnResumeAnyway.textContent = "Resume game";
      refs.btnToggleAutoOverlay.style.display = "none";
      return;
    }

    // auto-paused
    refs.badge.className = "badge";
    refs.badge.textContent =
      state.agentReason === "permission" ? "OPENCODE WAITING FOR PERMISSION" : "OPENCODE WAITING FOR PROMPT";
    refs.title.textContent = "Subway Surfers paused";
    refs.subtitle.textContent =
      state.agentReason === "permission"
        ? "Agent is waiting for a permission reply in OpenCode. Answer to resume automatically."
        : "No active tasks or background shells. Send a prompt in OpenCode to resume.";
    refs.btnResumeAnyway.textContent = "Resume anyway";
    refs.btnToggleAutoOverlay.style.display = "inline-block";
    refs.btnToggleAutoOverlay.textContent = "Disable auto-pause";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      evaluateAgentState();
      render();
    });
  } else {
    evaluateAgentState();
    render();
  }

  // Keep HUD alive across SPA navigation/hydration
  setInterval(() => {
    if (!ui || !ui.host.isConnected) render();
  }, 1500);

  window.__SUBWAY_WRAPPER__ = {
    onAgentState,
    toggleManualPause,
    toggleAutoPause,
    toggleTheaterMode,
    resumeFromAutoPause,
    getState: () => ({ ...state, gameFrozen: shouldGameBeFrozen() }),
  };
})();
