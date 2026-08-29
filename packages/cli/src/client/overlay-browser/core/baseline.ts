/**
 * Baseline capture — DOM snapshot + element position context (spec §6, §6.1).
 *
 * Runs in the browser (not Node.js). Uses standard DOM APIs.
 */

import type { DomSnapshot, PositionContext } from "./types.js";

// ── Computed styles to capture ────────────────────────────────────────────────

/** Subset of CSS properties that meaningfully describe element appearance. */
const RELEVANT_STYLES = [
  "display", "position", "visibility", "opacity",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "margin", "padding",
  "border", "border-radius", "border-color",
  "background-color", "background-image", "background-size",
  "color", "font-family", "font-size", "font-weight", "line-height",
  "text-align", "text-decoration", "text-transform", "text-overflow",
  "box-shadow", "outline",
  "flex-direction", "justify-content", "align-items", "gap",
  "grid-template-columns", "grid-template-rows",
  "z-index", "overflow", "cursor",
  "transform", "transition",
];

// ── XPath generation ──────────────────────────────────────────────────────────

/** Generate a unique XPath for an element. */
function getXPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    let index = 1;
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === node.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    const tag = node.tagName.toLowerCase();
    parts.unshift(`${tag}[${index}]`);
    node = node.parentElement;
  }
  return "/" + parts.join("/");
}

// ── Parent snippet ────────────────────────────────────────────────────────────

/** Get a truncated outerHTML of the nearest meaningful ancestor. */
function getParentSnippet(el: Element): string | undefined {
  const parent = el.parentElement;
  if (!parent || parent === document.body) return undefined;

  const html = parent.outerHTML;
  // Truncate to ~500 chars to keep the snapshot manageable
  if (html.length <= 500) return html;
  return html.slice(0, 500) + "…";
}

// ── UA string ─────────────────────────────────────────────────────────────────

/** Derive a browser identifier from the user agent. */
function getBrowserString(): string {
  return navigator.userAgent;
}

// ── Position context (spec §6.1) ──────────────────────────────────────────────

/** Capture element position context for layout shift detection. */
export function capturePositionContext(el: HTMLElement): PositionContext {
  const rect = el.getBoundingClientRect();

  // Walk up to find the nearest positioned ancestor for stacking context info
  let zIndex = "auto";
  let position = "static";
  let parentZIndex: string | undefined;

  let current: HTMLElement | null = el;
  while (current && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const pos = style.position;
    const z = style.zIndex;

    if (pos !== "static" || z !== "auto") {
      if (current === el) {
        position = pos;
        zIndex = z;
      } else if (parentZIndex === undefined) {
        parentZIndex = z;
        break;
      }
    }

    if (pos !== "static") break;
    current = current.parentElement;
  }

  return {
    boundingBox: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    scrollPosition: {
      x: window.scrollX,
      y: window.scrollY,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
    stackingContext: {
      zIndex,
      position,
      parentZIndex,
    },
  };
}

// ── Computed styles capture ───────────────────────────────────────────────────

/** Capture relevant computed styles for an element. */
function captureComputedStyles(el: HTMLElement): Record<string, string> {
  const style = window.getComputedStyle(el);
  const result: Record<string, string> = {};

  for (const prop of RELEVANT_STYLES) {
    result[prop] = style.getPropertyValue(prop);
  }

  return result;
}

// ── Main snapshot capture (spec §6) ───────────────────────────────────────────

/**
 * Capture a full DOM snapshot of an element at the current point in time.
 *
 * @param el - The HTML element to snapshot
 * @param cssSelector - The CSS selector that identifies this element
 * @param consoleErrors - Recent console errors from the error-recorder
 * @returns A frozen DomSnapshot with all captured state
 */
export function captureDomSnapshot(
  el: HTMLElement,
  cssSelector: string,
  consoleErrors: string[] = [],
): DomSnapshot {
  return {
    outerHTML: el.outerHTML,
    computedStyles: captureComputedStyles(el),
    selector: cssSelector,
    xpath: getXPath(el),
    position: capturePositionContext(el),
    parentSnippet: getParentSnippet(el),
    browser: getBrowserString(),
    consoleErrors,
    capturedAt: new Date().toISOString(),
  };
}
