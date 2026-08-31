/**
 * Page-wide capture — runs inside Playwright page.evaluate().
 *
 * Builds the full element tree with styles for every element that
 * has at least one class or data-attribute. Pure browser code — no
 * imports from Node modules.
 */

import type { PageElementRecord, PageSnapshot } from "./page-types.js";
import {
  RELEVANT_STYLES,
  buildKey,
  buildDisplaySelector,
  filterStyles,
  normalizeText,
  childSignature,
} from "./page-selector.js";

// Hard cap on elements to keep evidence files manageable
const MAX_ELEMENTS = 1000;

/**
 * Capture every meaningful element on the page.
 *
 * This is evaluated inside page.evaluate() so it must be self-contained —
 * no external imports or Node.js APIs.
 */
export function capturePageSnapshot(
  relevantStyles: string[] = RELEVANT_STYLES,
): PageSnapshot {
  const elements: Record<string, PageElementRecord> = {};
  let count = 0;
  let truncated = false;

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node: Node): number {
        if (count >= MAX_ELEMENTS) return NodeFilter.FILTER_REJECT;
        const el = node as Element;
        // Include: any element with classes or data-attributes
        if (el.classList.length > 0 || el.hasAttribute('data-task-id') || el.hasAttribute('data-status') || el.hasAttribute('data-column-id')) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  const queue: Element[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    queue.push(node as Element);
  }

  for (const el of queue) {
    if (count >= MAX_ELEMENTS) {
      truncated = true;
      break;
    }

    const key = buildKey(el);
    const selector = buildDisplaySelector(el);
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList);
    const dataAttrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-")) {
        dataAttrs[attr.name.slice(5)] = attr.value;
      }
    }

    const parentEl = el.parentElement;
    const parentKey = parentEl ? buildKey(parentEl) : "";

    const children = Array.from(el.children);
    const childCount = children.length;
    const sig = childSignature(children);

    const visibleText = normalizeText(el.textContent ?? "");

    let position = { x: 0, y: 0, width: 0, height: 0 };
    try {
      const rect = el.getBoundingClientRect();
      position = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    } catch {
      // getBoundingClientRect can fail on hidden elements
    }

    const styles = filterStyles(el, relevantStyles);

    elements[key] = {
      key,
      selector,
      tag,
      classes,
      dataAttrs,
      parentKey,
      childCount,
      childSignature: sig,
      text: visibleText,
      position,
      baseline: styles, // will become baseline in the second capture
      after: styles,    // first capture IS the "after" (or baseline if run twice)
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
