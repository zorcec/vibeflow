import { describe, it, expect } from "vitest";
import {
  getBlockers,
  getChildren,
  getDescendants,
  getLeafDescendants,
  getParent,
  groupDetailRelations,
  groupTasksByRoot,
  resolveRootTask,
} from "../task-links";
import type { Task } from "../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    status: "todo",
    ...overrides,
  };
}

/**
 * P0 regression: a single null/undefined entry in the task list (from a
 * stale WS frame / optimistic-update race) used to throw
 * "Cannot read properties of null (reading 'title' | 'links' | 'id')"
 * inside Array.map/filter during render, blanking the whole board.
 * Every link/tree helper must tolerate null entries instead of throwing.
 */
describe("task-links null-entry safety (P0 board-blank regression)", () => {
  // Vitest: cast needed — the runtime array really contains nulls.
  const listWithNulls = [
    null,
    undefined,
    makeTask({
      id: "blocked-1",
      links: [{ taskId: "task-1", type: "blocks" }],
    }),
    makeTask({ id: "child-1", links: [{ taskId: "root-1", type: "parent" }] }),
  ] as unknown as Task[];

  it("getBlockers does not throw and skips null entries", () => {
    const blockers = getBlockers(listWithNulls, "task-1");
    expect(blockers.map((b) => b.id)).toEqual(["blocked-1"]);
    // the exact crash site: mapping titles over the result
    expect(() => blockers.map((b) => b?.title ?? "Untitled")).not.toThrow();
    expect(blockers.map((b) => b?.title)).toEqual(["Test task"]);
  });

  it("getChildren does not throw and skips null entries", () => {
    const kids = getChildren(listWithNulls, "root-1");
    expect(kids.map((c) => c.id)).toEqual(["child-1"]);
  });

  it("getDescendants / getLeafDescendants do not throw with null entries", () => {
    const withTree = [
      null,
      makeTask({ id: "root-1" }),
      makeTask({ id: "mid-1", links: [{ taskId: "root-1", type: "parent" }] }),
      makeTask({ id: "leaf-1", links: [{ taskId: "mid-1", type: "parent" }] }),
    ] as unknown as Task[];
    expect(getDescendants(withTree, "root-1")).toEqual(["mid-1", "leaf-1"]);
    expect(getLeafDescendants(withTree, "root-1").map((t) => t.id)).toEqual([
      "leaf-1",
    ]);
  });

  it("resolveRootTask / getParent do not throw with null entries", () => {
    expect(resolveRootTask(listWithNulls, "child-1")).toBe("root-1");
    expect(getParent(listWithNulls, "child-1")).toBeUndefined();
  });

  it("groupTasksByRoot does not throw and skips null entries", () => {
    const grouping = groupTasksByRoot(listWithNulls);
    // nulls skipped; child-1's root (root-1) is absent → standalone fallback
    expect(grouping.standalone.map((t) => t.id)).toEqual([
      "blocked-1",
      "child-1",
    ]);
  });

  it("groupDetailRelations does not throw with null link entries", () => {
    const task = {
      ...makeTask(),
      links: [null, { taskId: "missing", type: "parent" } as never],
    } as unknown as Task;
    expect(() => groupDetailRelations(task, listWithNulls)).not.toThrow();
    const groups = groupDetailRelations(task, listWithNulls);
    expect(groups.parentLinks).toHaveLength(1);
    expect(groups.parentLinks[0].target).toBeUndefined();
  });

  it("rendering a blockers list containing null entries does not throw (TaskCard title path)", () => {
    // Mirrors TaskCard.tsx: `blockers.map((b) => b?.title ?? "Untitled")`
    const blockers = [null, makeTask()] as unknown as Task[];
    const label = blockers.map((b) => b?.title ?? "Untitled").join(", ");
    expect(label).toBe("Untitled, Test task");
  });
});
