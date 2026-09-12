export { renderMarkdown } from "../renderMarkdown";

const LS_SEEN_KEY = "proto-comments-seen";

export function isNewComments(taskId: string, count: number): boolean {
  try {
    const raw = localStorage.getItem(LS_SEEN_KEY);
    const seen: Record<string, number> = raw
      ? (JSON.parse(raw) as Record<string, number>)
      : {};
    return count > (seen[taskId] ?? 0);
  } catch {
    return false;
  }
}

export function markCommentsSeen(taskId: string, count: number): void {
  try {
    const raw = localStorage.getItem(LS_SEEN_KEY);
    const seen: Record<string, number> = raw
      ? (JSON.parse(raw) as Record<string, number>)
      : {};
    seen[taskId] = count;
    localStorage.setItem(LS_SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Fractional sort key generation for kanban drag-and-drop ordering.
//
// Keys are zero-padded 16-digit decimal integers stored as strings — they sort
// correctly both lexicographically and numerically.
//
// Fractional levels (e.g. "0000001000.0000005000") are used when two adjacent
// integer keys need a key between them.
//
// Non-numeric legacy keys (e.g. the default 'n') parse as MAX_INT so they
// always appear at the bottom of a column until explicitly reordered.
// ---------------------------------------------------------------------------

const KEY_DIGITS = 16;
const INITIAL_GAP = 1_000_000n; // gap between sequential items
const MAX_INT = BigInt("9".repeat(KEY_DIGITS));

function padKey(n: bigint): string {
  const clamped = n < 0n ? 0n : n > MAX_INT ? MAX_INT : n;
  return clamped.toString().padStart(KEY_DIGITS, "0");
}

/** Parse the first `.`-separated segment of a key as a BigInt. */
function parseFirstPart(k: string): bigint {
  const seg = k.split(".")[0];
  if (/^\d+$/.test(seg)) return BigInt(seg);
  // Non-numeric legacy key (e.g. 'n') sorts at the very end
  return MAX_INT;
}

/** Return the remainder after the first `.`, or null if there is none. */
function restPart(k: string): string | null {
  const dot = k.indexOf(".");
  return dot >= 0 ? k.slice(dot + 1) : null;
}

/**
 * Generates a sort key K such that `before < K < after` when compared with
 * the standard JS string `<` operator.
 *
 * Pass `null` for `before` to mean "before all keys" (0), or `null` for
 * `after` to mean "after all keys" (append to end).
 */
export function generateSortKeyBetween(
  before: string | null,
  after: string | null,
): string {
  // "Append after everything" — use before + gap
  if (after === null) {
    if (before === null) return padKey(INITIAL_GAP);
    const bInt = parseFirstPart(before);
    // If before is a numeric key, step by INITIAL_GAP
    if (bInt < MAX_INT - INITIAL_GAP) return padKey(bInt + INITIAL_GAP);
    // Not much room left; deepen the fractional level
    const bRest = restPart(before) ?? "0".repeat(KEY_DIGITS);
    return padKey(bInt) + "." + generateSortKeyBetween(bRest, null);
  }

  // "Prepend before everything"
  if (before === null) {
    const aInt = parseFirstPart(after);
    const aRest = restPart(after);
    if (aInt > INITIAL_GAP) return padKey(aInt - INITIAL_GAP);
    if (aRest !== null)
      return padKey(aInt) + "." + generateSortKeyBetween(null, aRest);
    // aInt <= INITIAL_GAP and no fractional part: go below the integer
    if (aInt > 0n) return padKey(aInt / 2n);
    // Can't go below 0; this shouldn't happen in practice
    return padKey(0n) + ".0";
  }

  const bInt = parseFirstPart(before);
  const aInt = parseFirstPart(after);
  const bRest = restPart(before);
  const aRest = restPart(after);

  if (aInt > bInt + 1n) {
    // Plenty of room between the integer parts
    return padKey((bInt + aInt) / 2n);
  }

  if (aInt === bInt + 1n) {
    // Adjacent integers: deepen on the before side
    // Any `bInt.X` satisfies bInt < bInt.X < bInt+1 (because '.' < any digit)
    return padKey(bInt) + "." + generateSortKeyBetween(bRest, null);
  }

  // aInt === bInt — same integer base, recurse into fractional level
  if (bRest === null && aRest === null) {
    // Should not happen (before === after)
    return padKey(bInt) + "." + padKey(INITIAL_GAP);
  }
  return padKey(bInt) + "." + generateSortKeyBetween(bRest, aRest);
}

/** Returns the initial sort keys to assign to N new items sequentially. */
export function initialSortKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    padKey(BigInt(i + 1) * INITIAL_GAP),
  );
}

/**
 * Comparator for sorting kanban tasks by sortKey ascending, falling back to
 * oldest-first by createdAt/updatedAt (new tasks appear at the bottom).
 * Pass directly to Array.sort().
 */
export function compareTaskOrder(
  a: {
    sortKey?: string | null;
    updatedAt?: string | null;
    createdAt?: string | null;
  },
  b: {
    sortKey?: string | null;
    updatedAt?: string | null;
    createdAt?: string | null;
  },
): number {
  if (a.sortKey && b.sortKey)
    return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
  if (a.sortKey) return -1;
  if (b.sortKey) return 1;
  return (a.updatedAt ?? a.createdAt ?? "").localeCompare(
    b.updatedAt ?? b.createdAt ?? "",
  );
}

export interface ReorderPatch {
  id: string;
  sortKey: string;
}

export interface ReorderResult {
  newSortKey: string;
  normalizationPatches: ReorderPatch[];
}

/**
 * Computes the new sort key for a dragged task and any normalization patches
 * needed for legacy 'n'-keyed tasks in the column.
 *
 * @param colTasks - Tasks in the target column, already sorted by compareTaskOrder.
 * @param taskId   - The task being dragged.
 * @param beforeId - The task that will be immediately before the dropped position, or null.
 * @param afterId  - The task that will be immediately after the dropped position, or null.
 */
export function computeReorder(
  colTasks: Array<{ id: string; sortKey?: string | null }>,
  taskId: string,
  beforeId: string | null,
  afterId: string | null,
): ReorderResult {
  const keyMap = new Map<string, string | null>();
  let lastNumericKey: string | null = null;
  for (const t of colTasks) {
    if (t.sortKey && t.sortKey !== "n") {
      keyMap.set(t.id, t.sortKey);
      lastNumericKey = t.sortKey;
    }
  }

  const normalizationPatches: ReorderPatch[] = [];
  const legacyTasks = colTasks.filter((t) => !t.sortKey || t.sortKey === "n");
  if (legacyTasks.length > 0) {
    let prevKey = lastNumericKey;
    for (const t of legacyTasks) {
      const normalizedKey = generateSortKeyBetween(prevKey, null);
      keyMap.set(t.id, normalizedKey);
      prevKey = normalizedKey;
      if (t.id !== taskId)
        normalizationPatches.push({ id: t.id, sortKey: normalizedKey });
    }
  }

  const beforeKey = beforeId ? (keyMap.get(beforeId) ?? null) : null;
  const afterKey = afterId ? (keyMap.get(afterId) ?? null) : null;
  const newSortKey = generateSortKeyBetween(beforeKey, afterKey);

  return { newSortKey, normalizationPatches };
}

/** Minimal task shape needed to plan a sortKey backfill. */
export interface BackfillTask {
  id: string;
  status: string;
  sortKey?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** A well-formed key: a zero-padded integer, optionally with fractional level. */
const WELL_FORMED_KEY = /^\d+(\.\d+)?$/;

/**
 * Plan a one-time sortKey backfill that preserves the comparator's rendered
 * order by construction.
 *
 * Anchors are tasks whose `sortKey` is well-formed AND unique across the WHOLE
 * store — those are left untouched. Every non-anchor (keyless, `'n'`, or a
 * duplicate key) is re-keyed with `generateSortKeyBetween(prev, next)` while
 * walking the stable-sorted copy, so each assigned key lands exactly where the
 * card already renders and every restriction of that order — status columns and
 * tree-sibling groups alike — is preserved.
 *
 * Why whole-store, not per-column: the comparator also orders mixed-status
 * tree-sibling groups. A cross-column duplicate left in place pins two equal
 * anchors around a duplicate sitting between them, and that middle task can
 * only be re-keyed after both — swapping sibling order. Measured on the real
 * store, per-column anchors reordered one parent group (`358fcff6`, 7 children
 * tied on `1000000`); whole-store anchors preserve every column and every
 * parent group. See `docs/plans/sortkey-fix.md` §7, correction 8.
 *
 * Idempotent: after the plan is applied every key is well-formed and globally
 * unique, so a second run returns an empty patch set.
 */
export function computeBackfillPlan(tasks: BackfillTask[]): ReorderPatch[] {
  // Count well-formed keys across the whole store to detect duplicates.
  const keyCounts = new Map<string, number>();
  for (const t of tasks) {
    if (!t.sortKey || !WELL_FORMED_KEY.test(t.sortKey)) continue;
    keyCounts.set(t.sortKey, (keyCounts.get(t.sortKey) ?? 0) + 1);
  }
  const isAnchor = (t: BackfillTask): boolean =>
    !!t.sortKey &&
    WELL_FORMED_KEY.test(t.sortKey) &&
    keyCounts.get(t.sortKey) === 1;

  // Stable sort reproduces the rendered order (both callers sort the same
  // load-ordered array with the same comparator).
  const sorted = [...tasks].sort(compareTaskOrder);

  // Precompute each index's next anchor key so the forward walk is O(n).
  const nextAnchorKey: Array<string | null> = new Array(sorted.length).fill(
    null,
  );
  let upcoming: string | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    nextAnchorKey[i] = upcoming;
    if (isAnchor(sorted[i])) upcoming = sorted[i].sortKey!;
  }

  const patches: ReorderPatch[] = [];
  let prevKey: string | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (isAnchor(t)) {
      prevKey = t.sortKey!;
      continue;
    }
    const newKey = generateSortKeyBetween(prevKey, nextAnchorKey[i]);
    patches.push({ id: t.id, sortKey: newKey });
    prevKey = newKey;
  }
  return patches;
}
