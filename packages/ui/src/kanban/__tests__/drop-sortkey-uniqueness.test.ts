import { describe, it, expect } from "vitest";
import { computeReorder, generateSortKeyBetween } from "../utils";
import { computeTreeReorder } from "../task-links";
import type { Task } from "../types";

/**
 * Regression: a drop must never mint a sortKey that is already taken elsewhere
 * in the store.
 *
 * `computeReorder` derives the key from the target column's neighbours only.
 * When the drop had no after-neighbour the append anchor was the last column
 * task, so the emitted key was `thatKey + INITIAL_GAP` — an exact point on the
 * store's shared 1_000_000 lattice. Measured against the real store, a single
 * "drop a card on its own column background" minted `0000024257863279`, which
 * `a472f35e` (a task in another column) already held, duplicating it. A drop
 * on a no-neighbour target was worse still: it fell through to
 * `generateSortKeyBetween(null, null)` — the CONSTANT `0000000001000000`.
 *
 * The fixture keys below are the real store's values, so the test fails for the
 * same reason the live board did.
 */

const COL_LAST = "0000024256863279"; // 27a72579 — last card in its column
const OTHER_COL = "0000024257863279"; // a472f35e — a task in a DIFFERENT column
const STORE_MAX = "0000024263863279"; // efe461f6 — highest key in the store
const CONSTANT = "0000000001000000";

function wellFormed(key: string): boolean {
  return /^\d+(\.\d+)?$/.test(key);
}

describe("drop sortKey minting is unique against the whole store", () => {
  it("a column-append does not land on another column's key", () => {
    const colTasks = [{ id: "last", sortKey: COL_LAST }];
    const keyUniverse = [
      { id: "last", sortKey: COL_LAST },
      { id: "other", sortKey: OTHER_COL },
      { id: "max", sortKey: STORE_MAX },
    ];

    const { newSortKey } = computeReorder(
      colTasks,
      "dragged",
      "last",
      null,
      STORE_MAX,
      keyUniverse,
    );

    // Pre-fix this was COL_LAST + INITIAL_GAP === OTHER_COL: a live duplicate.
    expect(newSortKey).not.toBe(OTHER_COL);
    expect(newSortKey).not.toBe(CONSTANT);
    expect(wellFormed(newSortKey)).toBe(true);
    expect(keyUniverse.some((t) => t.sortKey === newSortKey)).toBe(false);
  });

  it("a column-append still renders last (above the store max)", () => {
    const colTasks = [{ id: "last", sortKey: COL_LAST }];
    const keyUniverse = [
      { id: "last", sortKey: COL_LAST },
      { id: "other", sortKey: OTHER_COL },
      { id: "max", sortKey: STORE_MAX },
    ];

    const { newSortKey } = computeReorder(
      colTasks,
      "dragged",
      "last",
      null,
      STORE_MAX,
      keyUniverse,
    );

    const all = [...keyUniverse.map((t) => t.sortKey!), newSortKey].sort();
    expect(all[all.length - 1]).toBe(newSortKey);
    expect(newSortKey > STORE_MAX).toBe(true);
  });

  it("a mid-insert whose interval midpoint is taken re-mints into the free gap", () => {
    const before = "0000024250863279";
    const after = "0000024252863279";
    const midpoint = generateSortKeyBetween(before, after);
    // Premise: the neighbours really do bracket a key that already exists.
    expect(midpoint).toBe("0000024251863279");

    const keyUniverse = [
      { id: "before", sortKey: before },
      { id: "taken", sortKey: midpoint },
      { id: "after", sortKey: after },
    ];

    const { newSortKey } = computeReorder(
      [
        { id: "before", sortKey: before },
        { id: "after", sortKey: after },
      ],
      "dragged",
      "before",
      "after",
      null,
      keyUniverse,
    );

    expect(newSortKey).not.toBe(midpoint);
    expect(before < newSortKey).toBe(true);
    expect(newSortKey < after).toBe(true);
    expect(keyUniverse.some((t) => t.sortKey === newSortKey)).toBe(false);
  });

  it("the tree-reparent path stays unique against the whole store", () => {
    const only: Task[] = [
      { id: "r", title: "Root", status: "todo" },
      {
        id: "a",
        title: "Only child",
        status: "todo",
        sortKey: COL_LAST,
        links: [{ taskId: "r", type: "parent" }],
      },
      { id: "other", title: "Elsewhere", status: "done", sortKey: OTHER_COL },
      { id: "max", title: "Highest", status: "done", sortKey: STORE_MAX },
    ];

    const plan = computeTreeReorder(only, "a", "r", null, "after");
    expect(plan).not.toBeNull();
    expect(plan!.newSortKey).not.toBe(CONSTANT);
    expect(plan!.newSortKey).not.toBe(OTHER_COL);
    expect(
      only.some((t) => t.id !== "a" && t.sortKey === plan!.newSortKey),
    ).toBe(false);
  });

  it("an empty/universe-less call still returns a well-formed key", () => {
    const { newSortKey } = computeReorder([], "dragged", null, null, null, []);
    expect(wellFormed(newSortKey)).toBe(true);
  });

  it("keeps the legacy-'n' normalisation patches off the minted key", () => {
    const keyUniverse = [
      { id: "legacy", sortKey: undefined },
      { id: "other", sortKey: OTHER_COL },
    ];
    const { newSortKey, normalizationPatches } = computeReorder(
      [{ id: "legacy", sortKey: "n" }],
      "dragged",
      "legacy",
      null,
      null,
      keyUniverse,
    );
    expect(newSortKey).not.toBe(CONSTANT);
    for (const p of normalizationPatches) {
      expect(p.sortKey).not.toBe(newSortKey);
    }
    expect(keyUniverse.some((t) => t.sortKey === newSortKey)).toBe(false);
  });
});
