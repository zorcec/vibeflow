import { state } from "./state.js";
import { setupShadowDom, loadPrefs } from "./ui.js";
import { el } from "./dom.js";
import { connectWS, setupWsVisibilityReconnect } from "./ws.js";
import { fetchTasks, submitTask } from "./api.js";
import { fetchPages } from "./pages.js";
import { renderIndicators, setupIndicatorScrollRefresh, setupInteractionDebounce, setupClickOutsideTooltipClose } from "./indicators.js";
import { setupKeyboardShortcuts, setupContextMenuListener, setupClickToAnnotate, setupSpaNavigation } from "./events.js";
import { startRecording } from "./error-recorder.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { OverlayApp } from "../overlay-react/OverlayApp.js";

declare const PROTO_CONFIG: import("./types.js").ProtoConfig;

// ── Main overlay entry point ──────────────────────────────────────────────────

function main(): void {
  // Start recording console errors / warnings before anything else so even
  // early page errors are captured for bug reports.
  startRecording();

  // Self-identify as script-injected so the extension popup can detect it.
  // When the overlay is inlined via injectScript(), the script tag already has
  // data-vibeflow-overlay. When loaded via <script src="...vibeflow-overlay.js">,
  // we mark it here so the popup detects it the same way.
  // Prefer the script tag that carries a boardId (SaaS embed) so that the
  // CLI overlay script (src*="vibeflow-overlay") does not shadow it.
  const selfScript = (
    document.querySelector('script[data-board-id]') ??
    document.querySelector('script[src*="vibeflow-overlay"]')
  ) as HTMLScriptElement | null;
  if (selfScript && !selfScript.hasAttribute("data-vibeflow-overlay")) {
    selfScript.setAttribute("data-vibeflow-overlay", "");
  }
  // Read boardId from the script tag's data-board-id attribute (SaaS embed).
  // This MUST run before the early-return check so that re-injecting the script
  // with a boardId still updates PROTO_CONFIG even if the overlay is already active.
  if (selfScript?.dataset.boardId && !PROTO_CONFIG.boardId) {
    (PROTO_CONFIG as { boardId?: string }).boardId = selfScript.dataset.boardId;
  }
  // Fallback: read boardId from a global variable set by fetch+eval bookmarklets
  // in CSP-restricted environments where no script element is available.
  const globalBoardId = (window as unknown as Record<string, unknown>).__PROTO_BOARD_ID as string | undefined;
  if (globalBoardId && !PROTO_CONFIG.boardId) {
    (PROTO_CONFIG as { boardId?: string }).boardId = globalBoardId;
  }
  // Read the overlay API key from data-overlay-api-key for authenticated mutations.
  if (selfScript?.dataset.overlayApiKey && !PROTO_CONFIG.overlayApiKey) {
    (PROTO_CONFIG as { overlayApiKey?: string }).overlayApiKey = selfScript.dataset.overlayApiKey;
  }

  // Skip if already injected (by extension or another script tag)
  if (document.getElementById("vibeflow-studio-root")) return;

  // ── Shadow DOM ────────────────────────────────────────────────────────────
  const { host, root } = setupShadowDom();
  state.host = host;
  state.root = root;

  // ── Preferences ───────────────────────────────────────────────────────────
  loadPrefs();

  // ── Task indicators container (stays vanilla DOM — requires DOM positioning) ──
  const indicatorContainer = el("div", { className: "vibeflow-indicators" });
  state.indicatorContainer = indicatorContainer;
  root.appendChild(indicatorContainer);

  // ── React overlay (sidebar + corner trigger) ──────────────────────────────
  const reactContainer = document.createElement("div");
  reactContainer.className = "vibeflow-react-root";
  root.appendChild(reactContainer);

  const reactRoot = createRoot(reactContainer);

  reactRoot.render(
    React.createElement(OverlayApp, {
      onOpenKanban: () => {
        if (PROTO_CONFIG.boardId) {
          // SaaS mode: open the webapp kanban for this board
          const origin = new URL(PROTO_CONFIG.apiUrl).origin;
          window.open(`${origin}/kanban?board=${encodeURIComponent(PROTO_CONFIG.boardId)}`, '_blank', 'noopener');
        } else if (PROTO_CONFIG.wsUrl) {
          // Local CLI mode: open the local kanban server
          const kanbanUrl = PROTO_CONFIG.apiUrl.replace('/api/tasks', '/kanban');
          window.open(kanbanUrl, '_blank', 'noopener');
        }
      },
      onSubmitTask: (selector, cssSelector, title, description, status, type, meta) => {
        void submitTask(selector, cssSelector, title, description, status, meta, type);
      },
    }),
  );

  // ── Register task-fetch callback (updates indicators) ────────────────────
  state.onTasksFetched = () => {
    renderIndicators();
  };

  // ── WS tasks-updated triggers a fresh fetch ───────────────────────────────
  state.onTasksUpdatedMessage = fetchTasks;

  connectWS();
  setupWsVisibilityReconnect();

  // ── Initial data fetch ────────────────────────────────────────────────────
  void fetchTasks();
  void fetchPages();

  // ── Event listeners ───────────────────────────────────────────────────────
  setupKeyboardShortcuts(host);
  setupContextMenuListener(host);
  setupClickToAnnotate(host);
  setupIndicatorScrollRefresh();
  setupInteractionDebounce(host);
  setupClickOutsideTooltipClose(host);

  // ── SPA navigation detection ──────────────────────────────────────────────
  setupSpaNavigation(() => {
    if (location.href === state.currentHref) return;
    state.currentHref = location.href;
    renderIndicators();
  });
}

main();
