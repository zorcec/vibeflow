/**
 * Baseline capture — DOM snapshot + element position context (spec §6, §6.1).
 *
 * Runs in the browser (not Node.js). Uses standard DOM APIs.
 */

import type { DomSnapshot, PositionContext, PageSnapshot } from "./types.js";

// ── Computed styles to capture ────────────────────────────────────────────────

/** Subset of CSS properties that meaningfully describe element appearance. */
const RELEVANT_STYLES = [
  "display",
  "position",
  "visibility",
  "opacity",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "margin",
  "padding",
  "border",
  "border-radius",
  "border-color",
  "background-color",
  "background-image",
  "background-size",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "text-decoration",
  "text-transform",
  "text-overflow",
  "box-shadow",
  "outline",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "grid-template-columns",
  "grid-template-rows",
  "z-index",
  "overflow",
  "cursor",
  "transform",
  "transition",
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

// ── Page-wide snapshot capture ────────────────────────────────────────────────

/** CSS properties to capture for page-wide baseline. */
const PAGE_RELEVANT_STYLES = [
  "display","visibility","opacity","position",
  "overflow","overflow-x","overflow-y",
  "width","min-width","max-width","height","min-height","max-height",
  "margin","margin-top","margin-right","margin-bottom","margin-left",
  "padding","padding-top","padding-right","padding-bottom","padding-left",
  "border","border-width","border-style","border-color","border-radius",
  "background-color","background-image","color","font-size","font-weight",
  "font-style","font-family","line-height","letter-spacing","text-align",
  "text-decoration","text-overflow","white-space",
  "flex-direction","flex-wrap","flex","justify-content","align-items",
  "gap","row-gap","column-gap","z-index","box-shadow","transform","transition",
  "cursor","user-select","pointer-events","top","left","right","bottom",
];

function buildPageKey(el: Element): string {
  const path: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    const p: HTMLElement | null = cur.parentElement;
    if (!p) break;
    path.unshift(Array.from(p.children).indexOf(cur));
    cur = p;
  }
  return path.join("/");
}

function buildPageSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const taskId = el.getAttribute("data-task-id");
  if (taskId) return `${tag}[data-task-id=${taskId}]`;
  const status = el.getAttribute("data-status");
  if (status && el.classList.contains("column-scroll")) return `${tag}.column-scroll[data-status=${status}]`;
  const colId = el.getAttribute("data-column-id");
  if (colId) return `${tag}[data-column-id=${colId}]`;
  const classes = Array.from(el.classList).slice(0, 2);
  let sel = tag;
  if (classes.length) sel += "." + classes.join(".");
  const parent = el.parentElement;
  if (parent) {
    const sibs = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(el) + 1})`;
  }
  return sel;
}

function getPageStyles(el: Element): Record<string, string> {
  const computed = window.getComputedStyle(el);
  const r: Record<string, string> = {};
  for (const prop of PAGE_RELEVANT_STYLES) r[prop] = computed.getPropertyValue(prop);
  return r;
}

function childSig(children: Element[]): string[] {
  const counts = new Map<string, number>();
  for (const c of children) {
    const tag = c.tagName.toLowerCase();
    const cls = Array.from(c.classList).slice(0, 2).join(".");
    const key = cls ? `${tag}.${cls}` : tag;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([k, n]) => `${k} x${n}`).slice(0, 10);
}

/**
 * Capture a page-wide DOM snapshot (all visible elements with classes/data attrs).
 * Runs in the browser. Returns a PageSnapshot with element styles + structure.
 */
export function capturePageSnapshot(maxElements = 1000): PageSnapshot {
  const elements: PageSnapshot["elements"] = {};
  let count = 0;
  let truncated = false;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node) {
      if (count >= maxElements) return NodeFilter.FILTER_REJECT;
      const el = node as HTMLElement;
      if (el.classList.length > 0 || el.hasAttribute("data-task-id") || el.hasAttribute("data-status") || el.hasAttribute("data-column-id")) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    },
  });

  const queue: Element[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) queue.push(n as Element);

  for (const el of queue) {
    if (count >= maxElements) { truncated = true; break; }
    const key = buildPageKey(el);
    const children = Array.from(el.children);
    const dataAttrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith("data-")) dataAttrs[a.name.slice(5)] = a.value;
    }
    let position = { x: 0, y: 0, width: 0, height: 0 };
    try { const r = el.getBoundingClientRect(); position = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; } catch { /* hidden elements */ }

    elements[key] = {
      key, selector: buildPageSelector(el), tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList), dataAttrs,
      parentKey: el.parentElement ? buildPageKey(el.parentElement) : "",
      childCount: children.length, childSignature: childSig(children),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      position, baseline: getPageStyles(el), after: getPageStyles(el),
    };
    count++;
  }

  return { version: 1, capturedAt: new Date().toISOString(), truncated, elements };
}
