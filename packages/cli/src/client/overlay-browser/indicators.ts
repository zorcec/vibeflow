import type { ProtoConfig } from "./types.js";
declare const PROTO_CONFIG: ProtoConfig;
import type { Task } from "./types.js";
import { state } from "./state.js";
import { el } from "./dom.js";
import { showEditModal } from "./modal.js";
import { buildOverlayTaskCard } from "./task-card.js";

// ── Task indicators (dots on annotated elements) ──────────────────────────────
// Showcase: overlay-showcase.html → [data-vibeflow-id="showcase-indicators"]
// Tooltip: overlay-showcase.html → [data-vibeflow-id="showcase-tooltip"]

export function renderIndicators(): void {
  if (!state.indicatorContainer) return;
  state.indicatorContainer.replaceChildren();
  forceHideTooltip();
  if (!state.indicatorsVisible || state.tasks.length === 0) return;

  const currentPath = location.pathname;
  const pageTasks = state.tasks.filter(t => !t.url || t.url === currentPath);
  if (pageTasks.length === 0) return;

  // Group by CSS selector for DOM lookup (prefer cssSelector, fall back to selector)
  const bySelector: Record<string, Task[]> = {};
  for (const t of pageTasks) {
    const domSel = t.cssSelector || t.selector;
    if (!bySelector[domSel]) bySelector[domSel] = [];
    bySelector[domSel].push(t);
  }

  const vpW = window.innerWidth || document.documentElement.clientWidth;
  const vpH = window.innerHeight || document.documentElement.clientHeight;

  for (const sel of Object.keys(bySelector)) {
    const group = bySelector[sel];
    let targetEl: Element | null;
    try { targetEl = document.querySelector(sel); } catch { continue; }
    if (!targetEl) continue;

    const rect = targetEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > vpH || rect.right < 0 || rect.left > vpW) continue;

    const activeTasks = group.filter(t => t.status !== "done");
    const allDone = activeTasks.length === 0;
    if (allDone && !state.sidebarShowDone) continue;

    const indicator = el("div", { className: "vibeflow-task-indicator" + (allDone ? " all-done" : "") });
    indicator.textContent = allDone ? "✓" : String(activeTasks.length);
    indicator.style.left = `${rect.right - 10}px`;
    indicator.style.top = `${rect.top - 10}px`;

    const grp = group;
    const capturedAllDone = allDone;

    indicator.addEventListener("mouseenter", () => {
      if (!state.tooltipPinned) showIndicatorTooltip(indicator, grp);
    });
    indicator.addEventListener("mouseleave", (e: MouseEvent) => {
      if (state.tooltipPinned) return;
      const rel = e.relatedTarget as Node | null;
      if (state.activeTooltip && rel && (rel === state.activeTooltip || state.activeTooltip.contains(rel))) return;
      hideIndicatorTooltip();
    });
    indicator.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      if (grp.length === 1) {
        forceHideTooltip();
        showEditModal(grp[0]);
      } else {
        forceHideTooltip();
        showIndicatorTooltip(indicator, grp);
        state.tooltipPinned = true;
      }
    });

    state.indicatorContainer.appendChild(indicator);
  }
}

export function scheduleRenderIndicators(): void {
  if (state.indicatorRafId) return;
  state.indicatorRafId = requestAnimationFrame(() => {
    state.indicatorRafId = null;
    renderIndicators();
  });
}

function hideIndicatorTooltip(): void {
  if (state.tooltipPinned) return;
  if (state.activeTooltip) { state.activeTooltip.remove(); state.activeTooltip = null; }
}

function forceHideTooltip(): void {
  state.tooltipPinned = false;
  if (state.activeTooltip) { state.activeTooltip.remove(); state.activeTooltip = null; }
}

function showIndicatorTooltip(indicator: HTMLElement, group: Task[]): void {
  if (!state.root) return;
  hideIndicatorTooltip();

  const tooltip = el("div", { className: "vibeflow-task-tooltip" });

  const closeBtn = el("button", { className: "tooltip-close-btn" }, "✕");
  closeBtn.addEventListener("click", (e: Event) => { e.stopPropagation(); forceHideTooltip(); });
  tooltip.appendChild(closeBtn);

  for (const task of group) {
    const card = buildOverlayTaskCard(task, {
      currentPath: location.pathname,
      showSelector: false,
      showDescription: true,
      showActions: false,
      onOpen: (capturedTask) => {
        forceHideTooltip();
        showEditModal(capturedTask);
      },
    });
    tooltip.appendChild(card);
  }

  const iRect = indicator.getBoundingClientRect();
  tooltip.style.left = `${Math.min(iRect.right + 6, window.innerWidth - 330)}px`;
  tooltip.style.top = `${Math.max(4, Math.min(iRect.top - 8, window.innerHeight - 420))}px`;

  tooltip.addEventListener("mouseleave", hideIndicatorTooltip);
  state.root.appendChild(tooltip);
  state.activeTooltip = tooltip;
}

export function setupIndicatorScrollRefresh(): void {
  window.addEventListener("scroll", scheduleRenderIndicators, true);
  window.addEventListener("resize", scheduleRenderIndicators);
}

export function setupInteractionDebounce(host: HTMLElement): void {
  let interactionDebounce: ReturnType<typeof setTimeout> | null = null;
  function onUserInteraction(e: Event): void {
    if (e.composedPath().indexOf(host) !== -1) return;
    if (interactionDebounce) clearTimeout(interactionDebounce);
    interactionDebounce = setTimeout(() => {
      interactionDebounce = null;
      renderIndicators();
    }, 150);
  }
  document.addEventListener("click", onUserInteraction, true);
  document.addEventListener("keyup", onUserInteraction, true);
}

export function setupClickOutsideTooltipClose(host: HTMLElement): void {
  document.addEventListener("click", (e: MouseEvent) => {
    if (!state.tooltipPinned || !state.activeTooltip) return;
    const path = e.composedPath ? e.composedPath() : [e.target as Node];
    if (path.includes(host)) return;
    forceHideTooltip();
  }, true);
}
