/**
 * Diff and summarise page-wide snapshots.
 *
 * All functions operate on plain JSON — no browser APIs, no Playwright.
 * This keeps them fully unit-testable.
 */

import type {
  PageElementRecord,
  PageSnapshot,
  PageStyleChange,
  PageHtmlDiff,
  StyleDiffResult,
  StyleQueryResult,
  HtmlQueryResult,
} from "./page-types.js";

// ---------------------------------------------------------------------------
// style_diff
// ---------------------------------------------------------------------------

/** Diff baseline vs after across every element in the snapshot. */
export function diffPageStyles(
  baseline: PageSnapshot,
  after: PageSnapshot,
): { changes: PageStyleChange[]; added: string[]; removed: string[] } {
  const changes: PageStyleChange[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  // Walk the "after" snapshot — every key is either new or changed
  for (const [key, afterEl] of Object.entries(after.elements)) {
    const baseEl = baseline.elements[key];

    if (!baseEl || !baseEl.after) {
      // Element is new — it didn't exist in the baseline snapshot
      added.push(key);
      continue;
    }

    // Element existed before — diff its styles
    const baseStyles = baseEl.after; // "after" of baseline == starting state
    const afterStyles = afterEl.after;
    if (!baseStyles || !afterStyles) continue;

    for (const prop of Object.keys(baseStyles)) {
      const from = baseStyles[prop] ?? "";
      const to = afterStyles[prop] ?? "";
      if (from !== to) {
        changes.push({ key, selector: afterEl.selector, prop, from, to });
      }
    }
  }

  // Elements that existed in baseline but not in after
  for (const key of Object.keys(baseline.elements)) {
    if (!(key in after.elements)) {
      removed.push(key);
    }
  }

  return { changes, added, removed };
}

/** Produce the compact summary for style_diff. */
export function summarizeStyleDiff(
  changes: PageStyleChange[],
): StyleDiffResult {
  const byProp = new Map<string, Set<string>>();
  for (const c of changes) {
    if (!byProp.has(c.prop)) byProp.set(c.prop, new Set());
    byProp.get(c.prop)!.add(c.key);
  }

  const topChanges = Array.from(byProp.entries())
    .map(([prop, keys]) => ({ prop, elements: keys.size }))
    .sort((a, b) => b.elements - a.elements || a.prop.localeCompare(b.prop));

  const elementCount = new Set(changes.map((c) => c.key)).size;

  return { total: changes.length, elementCount, truncated: false, topChanges };
}

// ---------------------------------------------------------------------------
// style_query
// ---------------------------------------------------------------------------

/** Filter changes to a specific CSS property. */
export function queryStyleProperty(
  changes: PageStyleChange[],
  prop: string,
  allElements: Record<string, PageElementRecord>,
): StyleQueryResult {
  const matches = changes
    .filter((c) => c.prop === prop)
    .map((c) => {
      const el = allElements[c.key];
      return {
        selector: c.selector,
        tag: el?.tag ?? "?",
        childCount: el?.childCount ?? 0,
        from: c.from,
        to: c.to,
        isRelevant: Boolean(
          (c.from === "hidden" && c.to === "auto") ||
            (c.from === "visible" && c.to === "auto") ||
            (c.from === "line-through" && c.to === "none") ||
            (c.from === "none" && c.to !== "none"),
        ),
      };
    });

  return { prop, matches };
}

// ---------------------------------------------------------------------------
// html_query
// ---------------------------------------------------------------------------

/** Compare child counts between two snapshots. */
export function queryChildChanges(
  baseline: PageSnapshot,
  after: PageSnapshot,
): HtmlQueryResult {
  const matches: HtmlQueryResult["matches"] = [];

  for (const [key, afterEl] of Object.entries(after.elements)) {
    const baseEl = baseline.elements[key];
    if (!baseEl) continue;

    const from = baseEl.childCount;
    const to = afterEl.childCount;
    if (from === to) continue;

    const removed: string[] = [];
    const added = Math.max(0, to - from);

    if (from > to) {
      // Find which children were removed by comparing signatures
      const baseSigs = new Set(baseEl.childSignature);
      const afterSigs = new Set(afterEl.childSignature);
      for (const sig of baseSigs) {
        if (!afterSigs.has(sig)) removed.push(sig);
      }
    }

    const detail = [
      `children: ${from} → ${to}`,
      removed.length ? `removed: ${removed.join(", ")}` : "",
      added ? `added: ${added} element(s)` : "",
    ]
      .filter(Boolean)
      .join("; ");

    matches.push({ selector: afterEl.selector, details: detail });
  }

  return { queryType: "children", matches };
}

/** Compare visible text between two snapshots. */
export function queryTextChanges(
  baseline: PageSnapshot,
  after: PageSnapshot,
): HtmlQueryResult {
  const matches: HtmlQueryResult["matches"] = [];

  for (const [key, afterEl] of Object.entries(after.elements)) {
    const baseEl = baseline.elements[key];
    if (!baseEl) continue;
    if (baseEl.text === afterEl.text) continue;

    matches.push({
      selector: afterEl.selector,
      details: `text: "${truncate(baseEl.text, 60)}" → "${truncate(afterEl.text, 60)}"`,
    });
  }

  return { queryType: "text", matches };
}

/** Compare data-attributes between two snapshots. */
export function queryAttributeChanges(
  baseline: PageSnapshot,
  after: PageSnapshot,
): HtmlQueryResult {
  const matches: HtmlQueryResult["matches"] = [];

  for (const [key, afterEl] of Object.entries(after.elements)) {
    const baseEl = baseline.elements[key];
    if (!baseEl) continue;

    const allAttrs = new Set([
      ...Object.keys(baseEl.dataAttrs),
      ...Object.keys(afterEl.dataAttrs),
    ]);
    const changes: string[] = [];
    for (const attr of allAttrs) {
      const from = baseEl.dataAttrs[attr] ?? "";
      const to = afterEl.dataAttrs[attr] ?? "";
      if (from !== to) changes.push(`${attr}: "${from}" → "${to}"`);
    }

    if (changes.length > 0) {
      matches.push({ selector: afterEl.selector, details: changes.join("; ") });
    }
  }

  return { queryType: "attributes", matches };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
