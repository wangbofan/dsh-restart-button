/**
 * dsh-restart-button — client half.
 *
 * The native「应用」dropdown is assembled inside the Electron main process and has no
 * extension point, so this module puts the restart affordance next to it: it appends a
 * third button to the Windows titlebar menu bar (the open shadow root that the desktop
 * preload renders into the page) and, when that bar is not present, falls back to a small
 * floating button. Clicking it opens a confirm popover; confirming calls the Host route
 * `/restart-button/restart`, which closes and relaunches the whole application.
 */
window.__ModuleLoader__.load({
  id: "dsh-restart-button",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const name = "restart-button";
    const inject = [];
    const ENDPOINT = "/restart-button";
    const STYLE_ID = "dsh-restart-button-style";
    const FLOATING_ID = "dsh-restart-button-floating";
    const PROBE_TIMEOUT_MS = 3000;
    const PROBE_INTERVAL_MS = 2000;
    const PROBE_GIVE_UP_MS = 25000;
    const FALLBACK_MOUNT_MS = 2500;

    const TEXT = {
      zh: {
        button: "重启",
        title: "重启 DeepSeek Harness",
        body: "正在运行的任务会被中断。应用会关闭，然后自动重新打开。",
        confirm: "立即重启",
        cancel: "取消",
        restarting: "正在重启…",
        restartingHint: "窗口会在几秒内关闭并自动重新打开。",
        failed: "重启没有生效",
        failedHint: "可以再试一次；若仍无反应，请手动退出后重新打开应用。",
        retry: "重试",
        close: "关闭"
      },
      en: {
        button: "Restart",
        title: "Restart DeepSeek Harness",
        body: "Running tasks will be interrupted. The app closes and reopens automatically.",
        confirm: "Restart now",
        cancel: "Cancel",
        restarting: "Restarting…",
        restartingHint: "The window closes in a few seconds and reopens automatically.",
        failed: "Restart did not take effect",
        failedHint: "Try again, or quit and reopen the app manually.",
        retry: "Retry",
        close: "Close"
      }
    };

    function text() {
      const lang = String(document.documentElement.lang || navigator.language || "en").toLowerCase();
      return lang.startsWith("zh") ? TEXT.zh : TEXT.en;
    }

    const CSS = `
#${FLOATING_ID} { position: fixed; top: calc(var(--dsh-windows-titlebar-height, 40px) + 8px); right: 16px; z-index: 2147482998; height: 30px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1a1a1a); font: inherit; font-size: 13px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.12); }
#${FLOATING_ID}:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.dsh-restart-popover { position: fixed; z-index: 2147483000; box-sizing: border-box; width: 296px; padding: 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28)); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #fff)); color: var(--dsw-alias-label-primary, #1a1a1a); box-shadow: 0 12px 32px rgba(0,0,0,.18); font-family: var(--dsw-font-family, inherit); font-size: 13px; line-height: 1.55; }
.dsh-restart-popover[hidden] { display: none; }
.dsh-restart-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.dsh-restart-body { color: var(--dsw-alias-label-secondary, rgba(0,0,0,.62)); }
.dsh-restart-hint { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.62)); }
.dsh-restart-hint[hidden] { display: none; }
.dsh-restart-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.dsh-restart-actions[hidden] { display: none; }
.dsh-restart-action { height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid transparent; font: inherit; font-size: 13px; cursor: pointer; }
.dsh-restart-action-secondary { background: transparent; border-color: var(--dsw-alias-border-l1, rgba(127,127,127,.28)); color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-restart-action-secondary:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.dsh-restart-action-primary { background: var(--dsw-alias-brand-primary, #3b82f6); border-color: var(--dsw-alias-brand-primary, #3b82f6); color: #fff; }
.dsh-restart-action-primary:hover { filter: brightness(1.06); }
.dsh-restart-overlay { position: fixed; inset: 0; z-index: 2147483001; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 72%, transparent); backdrop-filter: blur(2px); }
.dsh-restart-overlay-box { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 22px 26px; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.28)); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #fff)); color: var(--dsw-alias-label-primary, #1a1a1a); box-shadow: 0 16px 40px rgba(0,0,0,.2); font-family: var(--dsw-font-family, inherit); }
.dsh-restart-spinner { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-top-color: var(--dsw-alias-brand-primary, #3b82f6); animation: dsh-restart-spin .8s linear infinite; }
@keyframes dsh-restart-spin { to { transform: rotate(360deg); } }
.dsh-restart-overlay-title { font-size: 14px; font-weight: 600; }
.dsh-restart-overlay-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(0,0,0,.62)); }
`;

    function apply(scope) {
      if (document.getElementById(STYLE_ID) !== null) return;

      let disposed = false;
      let busy = false;
      let popover = null;
      let overlay = null;
      let menuButton = null;
      let floatingButton = null;
      let anchorRect = null;
      let pollTimer = 0;
      let fallbackTimer = 0;
      const cleanups = [];

      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);

      /* ---------------------------------------------------------- HTTP */

      async function fetchJson(path, init, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${ENDPOINT}${path}`, { ...init, signal: controller.signal, cache: "no-store" });
          const payload = await response.json().catch(() => ({}));
          return { response, payload };
        } finally {
          clearTimeout(timer);
        }
      }

      async function requestStatus(timeoutMs) {
        const { response, payload } = await fetchJson("/status", { method: "GET", headers: { accept: "application/json" } }, timeoutMs ?? PROBE_TIMEOUT_MS);
        if (!response.ok) throw new Error(`status ${response.status}`);
        return payload;
      }

      async function requestRestart() {
        const { response, payload } = await fetchJson(
          "/restart",
          { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" },
          8000
        );
        if (!response.ok || payload?.ok !== true) throw new Error(String(payload?.error ?? `restart ${response.status}`));
        return payload;
      }

      /* ---------------------------------------------------------- popover */

      function createPopover() {
        const root = document.createElement("div");
        root.className = "dsh-restart-popover";
        root.setAttribute("role", "dialog");
        root.hidden = true;

        const title = document.createElement("div");
        title.className = "dsh-restart-title";
        const body = document.createElement("div");
        body.className = "dsh-restart-body";
        const hint = document.createElement("div");
        hint.className = "dsh-restart-hint";
        hint.hidden = true;
        const actions = document.createElement("div");
        actions.className = "dsh-restart-actions";

        const secondary = document.createElement("button");
        secondary.type = "button";
        secondary.className = "dsh-restart-action dsh-restart-action-secondary";
        const primary = document.createElement("button");
        primary.type = "button";
        primary.className = "dsh-restart-action dsh-restart-action-primary";
        actions.append(secondary, primary);
        root.append(title, body, hint, actions);
        document.body.append(root);

        secondary.addEventListener("click", () => hidePopover());
        primary.addEventListener("click", () => void confirmRestart());
        root.addEventListener("pointerdown", (event) => event.stopPropagation());

        return { root, title, body, hint, actions, secondary, primary, mode: "confirm" };
      }

      function renderPopover() {
        if (popover === null) return;
        const copy = text();
        if (popover.mode === "busy") {
          popover.title.textContent = copy.restarting;
          popover.body.textContent = copy.restartingHint;
          popover.hint.hidden = true;
          popover.actions.hidden = true;
          return;
        }
        popover.actions.hidden = false;
        if (popover.mode === "failed") {
          popover.title.textContent = copy.failed;
          popover.body.textContent = copy.failedHint;
          popover.secondary.textContent = copy.close;
          popover.primary.textContent = copy.retry;
          return;
        }
        popover.title.textContent = copy.title;
        popover.body.textContent = copy.body;
        popover.secondary.textContent = copy.cancel;
        popover.primary.textContent = copy.confirm;
      }

      function setMode(mode) {
        if (popover === null) return;
        popover.mode = mode;
        renderPopover();
      }

      function positionPopover(rect) {
        if (popover === null) return;
        const width = 296;
        const margin = 12;
        const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
        const top = rect.bottom + 6;
        popover.root.style.left = `${Math.round(left)}px`;
        popover.root.style.top = `${Math.round(Math.min(top, window.innerHeight - 160))}px`;
      }

      function showPopover(rect) {
        if (popover === null) return;
        anchorRect = rect;
        if (rect !== null) positionPopover(rect);
        popover.root.hidden = false;
        if (menuButton !== null) menuButton.setAttribute("aria-expanded", "true");
        popover.primary.focus?.();
      }

      function hidePopover() {
        if (popover === null) return;
        popover.root.hidden = true;
        if (menuButton !== null) menuButton.setAttribute("aria-expanded", "false");
      }

      function togglePopover(rect) {
        if (popover === null) return;
        if (popover.root.hidden) {
          if (busy) return;
          setMode("confirm");
          showPopover(rect);
        } else {
          hidePopover();
        }
      }

      /* ---------------------------------------------------------- overlay */

      function showOverlay() {
        if (overlay !== null) return;
        const copy = text();
        overlay = document.createElement("div");
        overlay.className = "dsh-restart-overlay";
        const box = document.createElement("div");
        box.className = "dsh-restart-overlay-box";
        const spinner = document.createElement("div");
        spinner.className = "dsh-restart-spinner";
        const title = document.createElement("div");
        title.className = "dsh-restart-overlay-title";
        title.textContent = copy.restarting;
        const hint = document.createElement("div");
        hint.className = "dsh-restart-overlay-hint";
        hint.textContent = copy.restartingHint;
        box.append(spinner, title, hint);
        overlay.append(box);
        document.body.append(overlay);
      }

      function hideOverlay() {
        if (overlay === null) return;
        overlay.remove();
        overlay = null;
      }

      /* ---------------------------------------------------------- restart */

      function pollUntilGone() {
        const startedAt = Date.now();
        const tick = async () => {
          if (disposed) return;
          try {
            await requestStatus();
          } catch {
            // The Host is gone: the app is on its way down and will come back on its own.
            return;
          }
          if (Date.now() - startedAt > PROBE_GIVE_UP_MS) {
            busy = false;
            hideOverlay();
            setMode("failed");
            showPopover(anchorRect ?? { left: 16, bottom: 8 });
            return;
          }
          pollTimer = window.setTimeout(() => void tick(), PROBE_INTERVAL_MS);
        };
        pollTimer = window.setTimeout(() => void tick(), PROBE_INTERVAL_MS);
      }

      async function confirmRestart() {
        if (busy || popover === null) return;
        busy = true;
        setMode("busy");
        try {
          await requestRestart();
        } catch (error) {
          busy = false;
          console.warn("[restart-button] restart request failed", error);
          setMode("failed");
          return;
        }
        showOverlay();
        hidePopover();
        pollUntilGone();
      }

      /* ---------------------------------------------------------- mounting */

      function menuBar() {
        const host = document.querySelector("[data-windows-menu]");
        const shadow = host?.shadowRoot;
        const bar = shadow?.querySelector('[role="menubar"]');
        return bar ? { host, shadow, bar } : null;
      }

      function createMenuButton() {
        const button = document.createElement("button");
        button.type = "button";
        button.id = "dsh-restart-button-menubar";
        button.setAttribute("role", "menuitem");
        button.setAttribute("aria-haspopup", "dialog");
        button.setAttribute("aria-expanded", "false");
        button.tabIndex = -1;
        button.textContent = text().button;
        button.title = text().title;
        // Match the built-in buttons: keep focus on the menu bar, open on click.
        button.addEventListener("pointerdown", (event) => event.preventDefault());
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          togglePopover(button.getBoundingClientRect());
        });
        button.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            hidePopover();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            togglePopover(button.getBoundingClientRect());
            return;
          }
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const buttons = Array.from(button.parentElement?.querySelectorAll("button") ?? []);
          if (buttons.length < 2) return;
          event.preventDefault();
          const index = buttons.indexOf(button);
          const step = event.key === "ArrowRight" ? 1 : -1;
          const next = buttons[(index + step + buttons.length) % buttons.length];
          next.focus?.();
        });
        return button;
      }

      function mountMenuButton(bar) {
        if (disposed || menuButton !== null) return;
        menuButton = createMenuButton();
        bar.append(menuButton);
      }

      function mountFloatingButton() {
        if (disposed || floatingButton !== null || menuButton !== null) return;
        floatingButton = document.createElement("button");
        floatingButton.type = "button";
        floatingButton.id = FLOATING_ID;
        floatingButton.textContent = text().button;
        floatingButton.title = text().title;
        floatingButton.addEventListener("click", (event) => {
          event.preventDefault();
          togglePopover(floatingButton.getBoundingClientRect());
        });
        document.body.append(floatingButton);
      }

      function watchMenuBar() {
        const found = menuBar();
        if (found !== null) {
          mountMenuButton(found.bar);
          return;
        }
        const observer = new MutationObserver(() => {
          const target = menuBar();
          if (target === null) return;
          observer.disconnect();
          mountMenuButton(target.bar);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        cleanups.push(() => observer.disconnect());
      }

      function refreshTexts() {
        const copy = text();
        if (menuButton !== null) {
          menuButton.textContent = copy.button;
          menuButton.title = copy.title;
        }
        if (floatingButton !== null) {
          floatingButton.textContent = copy.button;
          floatingButton.title = copy.title;
        }
        renderPopover();
        if (overlay !== null) {
          const title = overlay.querySelector(".dsh-restart-overlay-title");
          const hint = overlay.querySelector(".dsh-restart-overlay-hint");
          if (title !== null) title.textContent = copy.restarting;
          if (hint !== null) hint.textContent = copy.restartingHint;
        }
      }

      /* ---------------------------------------------------------- wiring */

      const onDocumentPointerDown = (event) => {
        if (popover === null || popover.root.hidden) return;
        const target = event.target;
        if (popover.root.contains(target)) return;
        if (menuButton !== null && (target === menuButton || menuButton.contains(target))) return;
        if (floatingButton !== null && (target === floatingButton || floatingButton.contains(target))) return;
        hidePopover();
      };
      const onDocumentKeyDown = (event) => {
        if (event.key === "Escape" && popover !== null && !popover.root.hidden) hidePopover();
      };
      const onWindowResize = () => {
        if (popover !== null && !popover.root.hidden && anchorRect !== null) positionPopover(anchorRect);
      };

      document.addEventListener("pointerdown", onDocumentPointerDown, true);
      document.addEventListener("keydown", onDocumentKeyDown, true);
      window.addEventListener("resize", onWindowResize);
      const langObserver = new MutationObserver(() => refreshTexts());
      langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

      popover = createPopover();
      renderPopover();

      requestStatus()
        .then((status) => {
          if (disposed) return;
          if (status?.available !== true) {
            console.info("[restart-button] restart is unavailable in this environment:", status?.reason);
            return;
          }
          watchMenuBar();
          fallbackTimer = window.setTimeout(() => {
            if (menuButton === null) mountFloatingButton();
          }, FALLBACK_MOUNT_MS);
        })
        .catch((error) => {
          console.warn("[restart-button] status request failed", error);
        });

      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        window.clearTimeout(pollTimer);
        window.clearTimeout(fallbackTimer);
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
        document.removeEventListener("keydown", onDocumentKeyDown, true);
        window.removeEventListener("resize", onWindowResize);
        langObserver.disconnect();
        for (const dispose of cleanups) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
        cleanups.length = 0;
        menuButton?.remove();
        floatingButton?.remove();
        overlay?.remove();
        overlay = null;
        popover?.root.remove();
        popover = null;
        style.remove();
      };

      if (typeof scope?.effect === "function") scope.effect(() => cleanup);
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
