import { describe, it, expect } from "vitest";
import {
  compareTaskOrder,
  computeReorder,
  computeBackfillPlan,
  generateSortKeyBetween,
  type BackfillTask,
  type ReorderPatch,
} from "@vibeflow-tools/ui/kanban";

describe("compareTaskOrder", () => {
  it("sorts by sortKey ascending when both have keys", () => {
    const a = { sortKey: "0000000000000002", createdAt: "2024-01-02" };
    const b = { sortKey: "0000000000000001", createdAt: "2024-01-01" };
    expect(compareTaskOrder(a, b)).toBe(1);
    expect(compareTaskOrder(b, a)).toBe(-1);
  });

  it("tasks with sortKey come before tasks without", () => {
    const withKey = { sortKey: "0000000000000001" };
    const withoutKey = { createdAt: "2024-01-01" };
    expect(compareTaskOrder(withKey, withoutKey)).toBe(-1);
    expect(compareTaskOrder(withoutKey, withKey)).toBe(1);
  });

  it("falls back to oldest-first by createdAt when no sortKeys", () => {
    const older = { createdAt: "2024-01-01T00:00:00Z" };
    const newer = { createdAt: "2024-01-02T00:00:00Z" };
    // Older should come first (ascending order)
    expect(compareTaskOrder(older, newer)).toBe(-1);
    expect(compareTaskOrder(newer, older)).toBe(1);
  });

  it("falls back to oldest-first by updatedAt when no createdAt", () => {
    const older = { updatedAt: "2024-01-01T00:00:00Z" };
    const newer = { updatedAt: "2024-01-02T00:00:00Z" };
    expect(compareTaskOrder(older, newer)).toBe(-1);
    expect(compareTaskOrder(newer, older)).toBe(1);
  });

  it("uses updatedAt over createdAt when both present", () => {
    const a = { createdAt: "2024-01-01", updatedAt: "2024-01-03" };
    const b = { createdAt: "2024-01-02", updatedAt: "2024-01-02" };
    // a has later updatedAt, so it should come after b
    expect(compareTaskOrder(b, a)).toBe(-1);
  });

  it("returns 0 for identical timestamps", () => {
    const a = { createdAt: "2024-01-01T00:00:00Z" };
    const b = { createdAt: "2024-01-01T00:00:00Z" };
    expect(compareTaskOrder(a, b)).toBe(0);
  });

  it("returns 0 for identical sortKeys", () => {
    const a = { sortKey: "0000000000000001" };
    const b = { sortKey: "0000000000000001" };
    expect(compareTaskOrder(a, b)).toBe(0);
  });

  it("handles null sortKeys gracefully", () => {
    const a = { sortKey: null, createdAt: "2024-01-01" };
    const b = { sortKey: "0000000000000001" };
    expect(compareTaskOrder(a, b)).toBe(1);
    expect(compareTaskOrder(b, a)).toBe(-1);
  });
});

describe("computeReorder", () => {
  it("computes a sortKey between two existing keys", () => {
    const colTasks = [
      { id: "a", sortKey: "0000000000000001" },
      { id: "b", sortKey: "0000000000000003" },
    ];
    const result = computeReorder(colTasks, "c", "a", "b");
    // Midpoint between 1 and 3 is 2
    expect(result.newSortKey).toBe("0000000000000002");
  });

  it("computes a sortKey after the last item when dropped at end", () => {
    const colTasks = [
      { id: "a", sortKey: "0000000000000001" },
      { id: "b", sortKey: "0000000000000002" },
    ];
    const result = computeReorder(colTasks, "c", "b", null);
    // generateSortKeyBetween adds INITIAL_GAP (1_000_000) to the before key
    expect(result.newSortKey).toBe("0000000001000002");
  });

  it("computes a sortKey before the first item when dropped at start", () => {
    const colTasks = [
      { id: "a", sortKey: "0000000100000000" },
      { id: "b", sortKey: "0000000200000000" },
    ];
    const result = computeReorder(colTasks, "c", null, "a");
    // generateSortKeyBetween subtracts INITIAL_GAP (1_000_000) from the after key
    expect(result.newSortKey).toBe("0000000099000000");
  });

  it("normalizes legacy 'n' sort keys", () => {
    const colTasks = [
      { id: "a", sortKey: "0000000000000001" },
      { id: "b", sortKey: "n" },
    ];
    const result = computeReorder(colTasks, "c", "b", null);
    expect(result.normalizationPatches.length).toBeGreaterThan(0);
    expect(result.normalizationPatches[0].sortKey).not.toBe("n");
  });

  // Pins the current correct CLI behaviour (post-5574ca7): a keyless task
  // dropped below keyless siblings gets a key ABOVE them, so it does not jump
  // to the top of the column. The web reverted this by dropping the patches.
  it("drops a keyless task after a keyless sibling without jumping to the top", () => {
    const colTasks = [
      { id: "C", sortKey: "0000000000000001" },
      { id: "A" },
      { id: "B" },
    ];
    const result = computeReorder(colTasks, "A", "B", null);

    // Every re-keyed sibling sits strictly below the dragged task's new key.
    for (const patch of result.normalizationPatches) {
      expect(result.newSortKey > patch.sortKey).toBe(true);
    }

    const keyById = new Map<string, string | undefined>([
      ["C", "0000000000000001"],
      ["A", result.newSortKey],
      ...result.normalizationPatches.map((p): [string, string] => [
        p.id,
        p.sortKey,
      ]),
    ]);
    const finalOrder = colTasks
      .map((t) => ({ ...t, sortKey: keyById.get(t.id) ?? t.sortKey }))
      .sort(compareTaskOrder)
      .map((t) => t.id);

    expect(finalOrder).toEqual(["C", "B", "A"]);
  });

  // Regression: a drop with no neighbour in the target column (empty column, or
  // the dragged task is the column's only task) used to fall through to
  // generateSortKeyBetween(null, null) — the store's initial constant
  // `0000000001000000` — which already belongs to another column's task and
  // minted a cross-column duplicate (observed: fd1ddc21).
  it("anchors a no-neighbour drop after the store max, not the initial constant", () => {
    const storeMax = "0000024263628904";
    const result = computeReorder([], "dragged", null, null, storeMax);
    expect(result.newSortKey).not.toBe("0000000001000000");
    expect(result.newSortKey > storeMax).toBe(true);
    // And the old behaviour only survives when the store is genuinely empty.
    expect(computeReorder([], "dragged", null, null, null).newSortKey).toBe(
      "0000000001000000",
    );
  });
});

describe("generateSortKeyBetween mixed-width invariant", () => {
  // The store carries 27 keys of the 33-char fractional form
  // `0000000002249999.00000000NN000000` next to 1124 16-char integer keys.
  // compareTaskOrder is a plain lexicographic `<`/`>` on the string, so the
  // generator must produce a key that lands strictly between its neighbours
  // under that same comparison — not a numeric comparison, and not a length-
  // dependent one.
  it("places a 33-char fractional key strictly between its 16-char neighbours", () => {
    const before = "0000000002249999";
    const after = "0000000002250000";
    const key = generateSortKeyBetween(before, after);
    expect(key).toBe("0000000002249999.0000000001000000");
    expect(key.length).toBe(33);
    // Plain string comparison (what compareTaskOrder uses).
    expect(before < key).toBe(true);
    expect(key < after).toBe(true);
    // And the comparator agrees.
    expect(compareTaskOrder({ sortKey: before }, { sortKey: key })).toBe(-1);
    expect(compareTaskOrder({ sortKey: key }, { sortKey: after })).toBe(-1);
    expect(compareTaskOrder({ sortKey: key }, { sortKey: before })).toBe(1);
    expect(compareTaskOrder({ sortKey: after }, { sortKey: key })).toBe(1);
  });
});

/** Apply a patch list by id, returning a new array. */
function applyPatches(
  tasks: BackfillTask[],
  patches: ReorderPatch[],
): BackfillTask[] {
  const byId = new Map(patches.map((p) => [p.id, p.sortKey]));
  return tasks.map((t) =>
    byId.has(t.id) ? { ...t, sortKey: byId.get(t.id) } : t,
  );
}

/** Assert a task list is strictly totally ordered under compareTaskOrder. */
function expectStrictTotalOrder(tasks: BackfillTask[]): void {
  const sorted = [...tasks].sort(compareTaskOrder);
  for (let i = 1; i < sorted.length; i++) {
    expect(compareTaskOrder(sorted[i - 1], sorted[i])).toBeLessThan(0);
  }
}

describe("computeBackfillPlan", () => {
  it("keys keyless tasks after every anchor, preserving order", () => {
    const tasks: BackfillTask[] = [
      {
        id: "x",
        status: "todo",
        sortKey: "0000000005000000",
        createdAt: "2024-01-01",
      },
      { id: "a", status: "todo", createdAt: "2024-01-02" },
      { id: "b", status: "todo", createdAt: "2024-01-03" },
    ];

    const patches = computeBackfillPlan(tasks);
    expect(patches.map((p) => p.id)).toEqual(["a", "b"]);
    expect(patches[0].sortKey > "0000000005000000").toBe(true);
    expect(patches[1].sortKey > patches[0].sortKey).toBe(true);

    const patched = applyPatches(tasks, patches);
    expectStrictTotalOrder(patched);
    expect([...patched].sort(compareTaskOrder).map((t) => t.id)).toEqual([
      "x",
      "a",
      "b",
    ]);
  });

  it("re-keys a same-column duplicate group into a strict total order", () => {
    const tasks: BackfillTask[] = [
      {
        id: "a",
        status: "todo",
        sortKey: "0000000000000001",
        createdAt: "2024-01-01",
      },
      {
        id: "b",
        status: "todo",
        sortKey: "0000000000000005",
        createdAt: "2024-01-02",
      },
      {
        id: "c",
        status: "todo",
        sortKey: "0000000000000005",
        createdAt: "2024-01-03",
      },
      {
        id: "d",
        status: "todo",
        sortKey: "0000000000000009",
        createdAt: "2024-01-04",
      },
    ];

    const patches = computeBackfillPlan(tasks);
    // Only the duplicate members are touched; the surrounding anchors stay.
    expect(patches.map((p) => p.id).sort()).toEqual(["b", "c"]);

    const patched = applyPatches(tasks, patches);
    expectStrictTotalOrder(patched);
    expect([...patched].sort(compareTaskOrder).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("is idempotent — a second run produces an empty patch set", () => {
    const tasks: BackfillTask[] = [
      {
        id: "a",
        status: "todo",
        sortKey: "0000000000000001",
        createdAt: "2024-01-01",
      },
      {
        id: "b",
        status: "todo",
        sortKey: "0000000000000005",
        createdAt: "2024-01-02",
      },
      {
        id: "c",
        status: "todo",
        sortKey: "0000000000000005",
        createdAt: "2024-01-03",
      },
      { id: "d", status: "done", createdAt: "2024-01-04" },
    ];

    const first = computeBackfillPlan(tasks);
    expect(first.length).toBeGreaterThan(0);

    const patched = applyPatches(tasks, first);
    expect(computeBackfillPlan(patched)).toEqual([]);
  });

  it("re-keys cross-column duplicates so every key becomes store-unique", () => {
    const tasks: BackfillTask[] = [
      { id: "a", status: "todo", sortKey: "0000000000000005" },
      { id: "b", status: "done", sortKey: "0000000000000005" },
    ];
    const patches = computeBackfillPlan(tasks);
    // Neither is an anchor: a key that exists twice is not unique, so both are
    // re-keyed. Leaving them tied would let a same-column duplicate sandwiched
    // between them swap mixed-status sibling order (see the next test).
    expect(patches.map((p) => p.id).sort()).toEqual(["a", "b"]);
    expect(patches[0].sortKey).not.toBe(patches[1].sortKey);
  });

  // Regression for the mixed-status corner the per-column rule could not
  // handle: a same-column duplicate (x) sitting between two cross-column
  // anchors that share its key (a in todo, b in in-progress). Ordered by the
  // rendered order a < x < b, so the backfill must give all three distinct keys
  // in that order — otherwise x lands after b and the sibling order swaps.
  it("preserves a duplicate sandwiched between two equal cross-column anchors", () => {
    const tasks: BackfillTask[] = [
      {
        id: "a",
        status: "todo",
        sortKey: "0000000000000005",
        createdAt: "2024-01-01",
      },
      {
        id: "x",
        status: "review",
        sortKey: "0000000000000005",
        createdAt: "2024-01-02",
      },
      {
        id: "b",
        status: "in-progress",
        sortKey: "0000000000000005",
        createdAt: "2024-01-03",
      },
    ];
    const beforeOrder = [...tasks].sort(compareTaskOrder).map((t) => t.id);
    expect(beforeOrder).toEqual(["a", "x", "b"]);

    const patches = computeBackfillPlan(tasks);
    const patched = applyPatches(tasks, patches);
    expectStrictTotalOrder(patched);
    expect([...patched].sort(compareTaskOrder).map((t) => t.id)).toEqual([
      "a",
      "x",
      "b",
    ]);
    // The two anchors must no longer share a key.
    const keys = new Map(patched.map((t) => [t.id, t.sortKey]));
    expect(keys.get("a")).not.toBe(keys.get("b"));
    expect(keys.get("a")).not.toBe(keys.get("x"));
  });
});
