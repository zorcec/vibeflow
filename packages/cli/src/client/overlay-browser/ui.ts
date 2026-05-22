import { state, PREFS_KEY } from "./state.js";
import { OVERLAY_CSS, HOST_PAGE_CSS } from "./css.js";

// ── Shadow DOM setup ──────────────────────────────────────────────────────────

export function setupShadowDom(): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement("div");
  host.id = "vibeflow-studio-root";
  // Prevent the host element from intercepting pointer events on the outer page.
  // The shadow DOM's :host { pointer-events: none } only applies inside the shadow,
  // not to the host element from the outer document's perspective.
  host.style.pointerEvents = "none";
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = OVERLAY_CSS;
  root.appendChild(styleEl);

  const hostStyle = document.createElement("style");
  hostStyle.textContent = HOST_PAGE_CSS;
  document.head.appendChild(hostStyle);

  return { host, root };
}

// ── User preference helpers ───────────────────────────────────────────────────

export function loadPrefs(): void {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, unknown>;
    state.indicatorsVisible = p.indicatorsVisible === true;
    state.sidebarShowDone = p.sidebarShowDone !== false;
    state.showAllPages = p.showAllPages === true;
    state.theme = "dark";
    applyOverlayTheme(state.theme);
  } catch { /* ignore */ }
}

export function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      indicatorsVisible: state.indicatorsVisible,
      sidebarShowDone: state.sidebarShowDone,
      showAllPages: state.showAllPages,
      theme: state.theme,
    }));
  } catch { /* ignore */ }
}

export function applyOverlayTheme(theme: "dark"): void {
  state.theme = theme;
  if (state.host) {
    state.host.setAttribute("data-theme", theme);
  }
}

// ── Annotation highlight helpers ──────────────────────────────────────────────

export function startAnnotationHover(host: HTMLElement): void {
  document.addEventListener("mouseover", (e: MouseEvent) => onAnnotateMouseOver(e, host), true);
  document.addEventListener("mouseout", onAnnotateMouseOut, true);
}

export function stopAnnotationHover(host: HTMLElement): void {
  document.removeEventListener("mouseover", (e: MouseEvent) => onAnnotateMouseOver(e, host), true);
  document.removeEventListener("mouseout", onAnnotateMouseOut, true);
  if (state.hoverTarget) {
    try { (state.hoverTarget as HTMLElement).classList.remove("vibeflow-hover-highlight"); } catch { /* ignore */ }
    state.hoverTarget = null;
  }
}

function onAnnotateMouseOver(e: MouseEvent, host: HTMLElement): void {
  const t = e.target as Element;
  if (!t || t === document.documentElement || t === document.body) return;
  if (e.composedPath().indexOf(host) !== -1) return;
  if (state.hoverTarget === t) return;
  if (state.hoverTarget) {
    try { (state.hoverTarget as HTMLElement).classList.remove("vibeflow-hover-highlight"); } catch { /* ignore */ }
  }
  state.hoverTarget = t;
  try { (t as HTMLElement).classList.add("vibeflow-hover-highlight"); } catch { /* ignore */ }
}

function onAnnotateMouseOut(e: MouseEvent): void {
  const t = e.target as Element;
  if (t === state.hoverTarget) {
    try { (t as HTMLElement).classList.remove("vibeflow-hover-highlight"); } catch { /* ignore */ }
    state.hoverTarget = null;
  }
}

// ── Annotate highlight (right-click target) ───────────────────────────────────

export function setAnnotateHighlight(element: Element | null): void {
  clearAnnotateHighlight();
  if (!element) return;
  state.annotateHighlightTarget = element;
  try { (element as HTMLElement).classList.add("vibeflow-annotate-highlight"); } catch { /* ignore */ }
}

export function clearAnnotateHighlight(): void {
  if (state.annotateHighlightTarget) {
    try { (state.annotateHighlightTarget as HTMLElement).classList.remove("vibeflow-annotate-highlight"); } catch { /* ignore */ }
    state.annotateHighlightTarget = null;
  }
}
