import { describe, it, expect } from "vitest";
import { compareTaskOrder, computeReorder } from "@vibeflow-tools/ui/kanban";

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
});
