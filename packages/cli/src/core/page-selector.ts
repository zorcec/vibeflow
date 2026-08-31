/**
 * Browser-side helpers for building element keys and display selectors.
 *
 * These functions are designed to be evaluated inside Playwright page.evaluate().
 * They run in the browser context and produce stable, readable identifiers.
 */

/** The subset of computed styles we capture for every element */
export const RELEVANT_STYLES: string[] = [
 "display",
 "visibility",
 "opacity",
 "position",
 "overflow",
 "overflow-x",
 "overflow-y",
 "width",
 "min-width",
 "max-width",
 "height",
 "min-height",
 "max-height",
 "margin",
 "margin-top",
 "margin-right",
 "margin-bottom",
 "margin-left",
 "padding",
 "padding-top",
 "padding-right",
 "padding-bottom",
 "padding-left",
 "border",
 "border-width",
 "border-style",
 "border-color",
 "border-radius",
 "background-color",
 "background-image",
 "color",
 "font-size",
 "font-weight",
 "font-style",
 "font-family",
 "line-height",
 "letter-spacing",
 "text-align",
 "text-decoration",
 "text-overflow",
 "white-space",
 "flex-direction",
 "flex-wrap",
 "flex",
 "justify-content",
 "align-items",
 "gap",
 "row-gap",
 "column-gap",
 "grid-template-columns",
 "grid-template-rows",
 "z-index",
 "box-shadow",
 "transform",
 "transition",
 "cursor",
 "user-select",
 "pointer-events",
 "top",
 "left",
 "right",
 "bottom",
];

/**
 * Build a stable DOM-path key for an element.
 * Example: "0/1/3" means body > div:nth(1) > section:nth(3)
 *
 * IMPORTANT: This runs in browser context (page.evaluate).
 */
export function buildKey(el: Element): string {
 const path: number[] = [];
 let current: Element | null = el;
 while (current && current !== document.documentElement) {
  const parentEl: HTMLElement | null = current.parentElement;
  if (!parentEl) break;
  const index = Array.from(parentEl.children).indexOf(current as Element);
  path.unshift(index);
  current = parentEl;
 }
 return path.join("/");
}

/**
 * Build a human-readable display selector.
 * Examples: "div.column-scroll[data-status=backlog]"
 *           "article.task-card[data-task-id=abc]"
 *
 * IMPORTANT: This runs in browser context (page.evaluate).
 */
export function buildDisplaySelector(el: Element): string {
 const tag = el.tagName.toLowerCase();

 // Prefer data-task-id for task cards
 const taskId = el.getAttribute("data-task-id");
 if (taskId) return `${tag}.task-card[data-task-id=${taskId}]`;

 // Prefer data-status for scroll containers
 const status = el.getAttribute("data-status");
 if (status && el.classList.contains("column-scroll"))
  return `${tag}.column-scroll[data-status=${status}]`;

 // Prefer data-column-id for column wrappers
 const colId = el.getAttribute("data-column-id");
 if (colId) return `${tag}[data-column-id=${colId}]`;

 // Fall back to tag + first 2 classes
 const classes = Array.from(el.classList).slice(0, 2);
 let selector = tag;
 if (classes.length) selector += "." + classes.join(".");

 // Add nth-of-type when siblings share the same tag
 const parent = el.parentElement;
 if (parent) {
  const siblings = Array.from(parent.children).filter(
   (c) => c.tagName === el.tagName,
  );
  if (siblings.length > 1) {
   const idx = siblings.indexOf(el) + 1;
   selector += `:nth-of-type(${idx})`;
  }
 }

 return selector;
}

/**
 * Read a fixed set of computed style values for the element.
 *
 * IMPORTANT: This runs in browser context (page.evaluate).
 */
export function filterStyles(
 el: Element,
 styles: string[] = RELEVANT_STYLES,
): Record<string, string> {
 const computed = window.getComputedStyle(el);
 const result: Record<string, string> = {};
 for (const prop of styles) {
  result[prop] = computed.getPropertyValue(prop);
 }
 return result;
}

/** Collapse whitespace and trim to `limit` characters */
export function normalizeText(text: string, limit = 200): string {
 return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * Produce a compact child-type summary.
 * Example: ["div.task-card ×8", "div.hidden-count ×1"]
 *
 * IMPORTANT: This runs in browser context (page.evaluate).
 */
export function childSignature(children: Element[]): string[] {
 const counts = new Map<string, number>();
 for (const child of children) {
  const tag = child.tagName.toLowerCase();
  const classes = Array.from(child.classList).slice(0, 2).join(".");
  const key = classes ? `${tag}.${classes}` : tag;
  counts.set(key, (counts.get(key) || 0) + 1);
 }
 return Array.from(counts.entries())
  .map(([key, count]) => `${key} ×${count}`)
  .slice(0, 10); // cap at 10 groups
}
