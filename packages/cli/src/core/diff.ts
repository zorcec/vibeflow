// ── Structural diff engine (§10 — mechanical layer) ───────────────────────

import type {
  PositionContext,
  DomSnapshot,
  DiffResult,
} from "./verification-types.js";

export type {
  PositionContext,
  DomSnapshot,
  DiffResult,
} from "./verification-types.js";

/** Tolerance in pixels for bounding box comparison (sub-pixel jitter). */
const POSITION_TOLERANCE = 2;

function boundingBoxChanged(
  a: PositionContext["boundingBox"],
  b: PositionContext["boundingBox"],
): boolean {
  return (
    Math.abs(a.x - b.x) > POSITION_TOLERANCE ||
    Math.abs(a.y - b.y) > POSITION_TOLERANCE ||
    Math.abs(a.width - b.width) > POSITION_TOLERANCE ||
    Math.abs(a.height - b.height) > POSITION_TOLERANCE
  );
}

/**
 * Compute the structural diff between a baseline snapshot and a fresh "after" snapshot.
 *
 * This is the mechanical layer (§10): it proves *changed*, not *correct*.
 * The LLM agent reads the diff and applies semantic judgment separately.
 */
export function computeDiff(
  baseline: DomSnapshot,
  after: DomSnapshot,
): DiffResult {
  const selectorResolves = Boolean(after.outerHTML);

  const htmlChanged = baseline.outerHTML !== after.outerHTML;

  // Per-property computed style comparison.
  const stylesChanged: Record<string, [string, string]> = {};
  const allKeys = new Set([
    ...Object.keys(baseline.computedStyles),
    ...Object.keys(after.computedStyles),
  ]);
  for (const key of allKeys) {
    const bVal = baseline.computedStyles[key];
    const aVal = after.computedStyles[key];
    if (bVal !== aVal) {
      stylesChanged[key] = [bVal ?? "", aVal ?? ""];
    }
  }

  const positionChanged = boundingBoxChanged(
    baseline.position.boundingBox,
    after.position.boundingBox,
  );

  // Console error dedup: errors present in baseline are expected.
  const baselineErrors = new Set(baseline.consoleErrors);
  const newConsoleErrors = after.consoleErrors.filter(
    (e) => !baselineErrors.has(e),
  );

  return {
    selectorResolves,
    htmlChanged,
    stylesChanged,
    positionChanged,
    newConsoleErrors,
  };
}

/**
 * Build a human-readable summary string from the diff result.
 * Used for the system comment written on the task after verification.
 */
export function summarizeDiff(diff: DiffResult, selector: string): string {
  const parts: string[] = [];

  if (diff.selectorResolves) {
    if (diff.htmlChanged) parts.push("HTML changed");
    const styleCount = Object.keys(diff.stylesChanged).length;
    if (styleCount > 0) {
      const props = Object.keys(diff.stylesChanged).slice(0, 5).join(", ");
      const suffix = styleCount > 5 ? ` (+${styleCount - 5} more)` : "";
      parts.push(`${styleCount} style property change(s): ${props}${suffix}`);
    }
    if (diff.positionChanged) parts.push("position shifted");
    if (diff.newConsoleErrors.length > 0) {
      parts.push(`${diff.newConsoleErrors.length} new console error(s)`);
    }
    if (parts.length === 0) parts.push("no structural changes detected");
  } else {
    parts.push(`Selector "${selector}" no longer resolves`);
  }

  return parts.join("; ");
}
