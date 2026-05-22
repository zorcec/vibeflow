import type { ProtoConfig } from "./types.js";
declare const PROTO_CONFIG: ProtoConfig;
import { state } from "./state.js";
import { el } from "./dom.js";

// ── Page variant switcher ─────────────────────────────────────────────────────
// Showcase: overlay-showcase.html → [data-vibeflow-id="showcase-page-switcher"]─

const PAGES_URL = PROTO_CONFIG.pagesUrl;

export function fetchPages(): void {
  // SaaS mode: pagesUrl is empty string — skip to avoid fetching current page.
  if (!PAGES_URL) return;
  fetch(PAGES_URL)
    .then(r => r.json())
    .then((d: { pages?: string[] }) => {
      state.pages = d.pages ?? [];
      renderPageSwitcher();
    })
    .catch(() => { /* pages endpoint not available */ });
}

export function renderPageSwitcher(): void {
  if (state.pageSwitcher) { state.pageSwitcher.remove(); state.pageSwitcher = null; }
  if (!state.root || state.pages.length < 2) return;

  const currentPath = location.pathname;
  const switcher = el("div", { className: "vibeflow-page-switcher" });
  switcher.appendChild(el("span", { className: "page-switcher-label" }, "Pages:"));

  for (const page of state.pages) {
    const isActive = page === currentPath || (currentPath === "/" && page === "/index.html");
    const tab = el("a", {
      className: "page-tab" + (isActive ? " active" : ""),
      href: page,
    }, page.replace(/^\//, "").replace(/\.html$/, ""));
    switcher.appendChild(tab);
  }

  state.root.appendChild(switcher);
  state.pageSwitcher = switcher;
}
