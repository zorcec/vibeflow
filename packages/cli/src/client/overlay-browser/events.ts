import { state } from "./state.js";
import { el } from "./dom.js";
import { buildSourcePointer, buildSourcePointerAsync, buildCssSelector } from "./selectors.js";
import { showPopover } from "./popover.js";
import { toggleSidebar, closeSidebar } from "./sidebar.js";
import { setAnnotateHighlight, clearAnnotateHighlight, startAnnotationHover, stopAnnotationHover } from "./ui.js";
import { scheduleRenderIndicators } from "./indicators.js";
import { showAddTaskModal, showInspectModal } from "./modal.js";
import { setOverlayTriggerAnnotating, showOverlayTrigger, hideOverlayTrigger, disableVibeflowOverlay, TRIGGER_HIDDEN_KEY } from "../overlay-react/OverlayApp.js";

// ── Context menu (right-click) ────────────────────────────────────────────────

export function showContextMenu(element: Element, x: number, y: number): void {
  hideContextMenu();
  // Don't show the context menu if vibeflow is disabled for this session.
  if (state.disabled) return;
  const info = buildSourcePointer(element);
  const displayName = info.display;

  setAnnotateHighlight(element);

  if (!state.root) return;
  const menu = el("div", { className: "vibeflow-context-menu" });
  menu.style.left = `${Math.min(x, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;

  const annotateBtn = el("button", null,
    el("span", { className: "menu-icon" }, "📝"),
    `Annotate "${displayName.slice(0, 30)}"`,
  );
  annotateBtn.addEventListener("click", () => {
    hideContextMenu(true);
    showPopover(element, x, y);
  });
  menu.appendChild(annotateBtn);

  const inspectBtn = el("button", null,
    el("span", { className: "menu-icon" }, "🔍"),
    "Inspect selector",
  );
  inspectBtn.addEventListener("click", () => {
    hideContextMenu();
    void buildSourcePointerAsync(element).then(ptr => showInspectModal(element, ptr));
  });
  menu.appendChild(inspectBtn);

  // Show/Hide Vibeflow toggle — always visible regardless of badge state
  const isTriggerHidden = (() => {
    try { return localStorage.getItem(TRIGGER_HIDDEN_KEY) === '1'; } catch { return false; }
  })();
  if (isTriggerHidden) {
    const showBtn = el("button", null,
      el("span", { className: "menu-icon" }, "👁"),
      "Show Vibeflow",
    );
    showBtn.addEventListener("click", () => {
      hideContextMenu();
      showOverlayTrigger();
    });
    menu.appendChild(showBtn);
  } else {
    const hideBtn = el("button", null,
      el("span", { className: "menu-icon" }, "👁"),
      "Hide Vibeflow",
    );
    hideBtn.addEventListener("click", () => {
      hideContextMenu();
      hideOverlayTrigger();
    });
    menu.appendChild(hideBtn);
  }

  // Disable Vibeflow — completely removes all overlay activity for this session
  const disableBtn = el("button", null,
    el("span", { className: "menu-icon" }, "🚫"),
    "Disable Vibeflow",
  );
  disableBtn.addEventListener("click", () => {
    hideContextMenu();
    disableVibeflowOverlay();
  });
  menu.appendChild(disableBtn);

  state.contextMenu = menu;
  state.root.appendChild(menu);

  setTimeout(() => {
    document.addEventListener("click", function onClickClose() {
      hideContextMenu();
      document.removeEventListener("click", onClickClose);
    }, { once: true });
  }, 0);
}

export function hideContextMenu(keepHighlight?: boolean): void {
  if (state.contextMenu) { state.contextMenu.remove(); state.contextMenu = null; }
  if (!keepHighlight) clearAnnotateHighlight();
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

export function setupKeyboardShortcuts(host: HTMLElement): void {
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.altKey && e.key === "a") {
      e.preventDefault();
      toggleAnnotationMode(host);
    }
    if (e.altKey && e.key === "s") {
      e.preventDefault();
      toggleSidebar();
    }
    if (e.key === "Escape") {
      if (state.contextMenu) { hideContextMenu(); }
      else if (state.popover) { state.popover.remove(); state.popover = null; clearAnnotateHighlight(); }
      else if (state.annotationMode) { toggleAnnotationMode(host); }
      else if (state.sidebarPinned) {
        closeSidebar();
      }
    }
  }, true);
}

function toggleAnnotationMode(host: HTMLElement): void {
  state.annotationMode = !state.annotationMode;
  document.body.classList.toggle("vibeflow-overlay-active", state.annotationMode);
  setOverlayTriggerAnnotating(state.annotationMode);
  if (state.annotationMode) {
    startAnnotationHover(host);
  } else {
    stopAnnotationHover(host);
    if (state.popover) { state.popover.remove(); state.popover = null; }
  }
}

// ── Right-click context menu listener ────────────────────────────────────────

export function setupContextMenuListener(host: HTMLElement): void {
  document.addEventListener("contextmenu", (e: MouseEvent) => {
    const target = e.target as Element;
    if (!target || target === document.body || target === document.documentElement) return;
    if (e.composedPath().indexOf(host) !== -1) return;
    e.preventDefault();
    showContextMenu(target, e.clientX, e.clientY);
  }, true);
}

// ── Click-to-annotate ─────────────────────────────────────────────────────────

export function setupClickToAnnotate(host: HTMLElement): void {
  document.addEventListener("click", (e: MouseEvent) => {
    if (!state.annotationMode) return;
    if (e.composedPath().indexOf(host) !== -1) return;
    const target = e.target as Element;
    if (!target || target === document.body || target === document.documentElement) return;
    e.preventDefault();
    e.stopPropagation();
    void showPopover(target, e.clientX, e.clientY);
  }, true);
}

// ── SPA navigation detection ──────────────────────────────────────────────────

export function setupSpaNavigation(onRouteChange: () => void): void {
  const _protoOrigPush = history.pushState.bind(history);
  history.pushState = (...args: Parameters<typeof history.pushState>) => {
    _protoOrigPush(...args); onRouteChange();
  };
  const _protoOrigReplace = history.replaceState.bind(history);
  history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
    _protoOrigReplace(...args); onRouteChange();
  };
  window.addEventListener("popstate", onRouteChange);
  window.addEventListener("hashchange", onRouteChange);
}
