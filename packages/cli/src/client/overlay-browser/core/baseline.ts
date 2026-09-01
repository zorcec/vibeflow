/**
 * Baseline capture — DOM snapshot + element position context (spec §6, §6.1).
 *
 * Runs in the browser (not Node.js). Uses standard DOM APIs.
 */

import type { DomSnapshot, PositionContext, PageSnapshot } from "./types.js";
import {
  buildKey,
  buildDisplaySelector,
  filterStyles,
  childSignature,
  normalizeText,
  RELEVANT_STYLES,
} from "../../../core/page-selector.js";

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

/**
 * Capture a page-wide DOM snapshot (all visible elements with classes/data attrs).
 * Runs in the browser. Returns a PageSnapshot with element styles + structure.
 *
 * Uses shared helpers from page-selector.ts (buildKey, buildDisplaySelector,
 * filterStyles, childSignature, normalizeText, RELEVANT_STYLES).
 */
export function capturePageSnapshot(maxElements = 1000): PageSnapshot {
  const elements: PageSnapshot["elements"] = {};
  let count = 0;
  let truncated = false;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node: Node) {
        if (count >= maxElements) return NodeFilter.FILTER_REJECT;
        const el = node as HTMLElement;
        if (
          el.classList.length > 0 ||
          el.hasAttribute("data-task-id") ||
          el.hasAttribute("data-status") ||
          el.hasAttribute("data-column-id")
        )
          return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  const queue: Element[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) queue.push(n as Element);

  for (const el of queue) {
    if (count >= maxElements) {
      truncated = true;
      break;
    }
    const key = buildKey(el);
    const children = Array.from(el.children);
    const dataAttrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith("data-")) dataAttrs[a.name.slice(5)] = a.value;
    }
    let position = { x: 0, y: 0, width: 0, height: 0 };
    try {
      const r = el.getBoundingClientRect();
      position = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    } catch {
      /* hidden elements */
    }

    elements[key] = {
      key,
      selector: buildDisplaySelector(el),
      tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList),
      dataAttrs,
      parentKey: el.parentElement ? buildKey(el.parentElement) : "",
      childCount: children.length,
      childSignature: childSignature(children),
      text: normalizeText(el.textContent ?? ""),
      position,
      baseline: filterStyles(el, RELEVANT_STYLES),
      after: filterStyles(el, RELEVANT_STYLES),
    };
    count++;
  }

  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    truncated,
    elements,
  };
}
