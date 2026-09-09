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
  classifyTreeRowIntent,
  canReparent,
  dragSession,
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

describe("classifyTreeRowIntent (tree-row DnD bands)", () => {
  // 200px row → 28% band = 56px (max clamp). Top band [0,56), bottom (144,200].
  const rect = { top: 100, height: 200 };
  const child = { id: "c1" };

  it("top band → tree-row before", () => {
    expect(classifyTreeRowIntent(rect, 110, child, "p1")).toEqual({
      kind: "tree-row",
      targetId: "c1",
      parentId: "p1",
      position: "before",
    });
  });

  it("bottom band → tree-row after", () => {
    expect(classifyTreeRowIntent(rect, 290, child, "p1")).toEqual({
      kind: "tree-row",
      targetId: "c1",
      parentId: "p1",
      position: "after",
    });
  });

  it("center → zone intent (make-child of the row's task)", () => {
    expect(classifyTreeRowIntent(rect, 200, child, "p1")).toEqual({
      kind: "zone",
      parentId: "c1",
    });
  });

  it("returns null when the row task has no id (null-safe)", () => {
    expect(classifyTreeRowIntent(rect, 200, null, "p1")).toBeNull();
    expect(
      classifyTreeRowIntent(rect, 200, {} as { id?: string }, "p1"),
    ).toBeNull();
  });

  it("clamps small-row bands to 32px min", () => {
    // 100px row → raw band 28px → clamped to 32px: y=top+31 is top,
    // y=top+33 is center (bottom band starts at top+68).
    const small = { top: 0, height: 100 };
    expect(classifyTreeRowIntent(small, 31, child, "p1")?.position).toBe(
      "before",
    );
    expect(classifyTreeRowIntent(small, 33, child, "p1")?.kind).toBe("zone");
  });
});

describe("canReparent (self/descendant checks only)", () => {
  const tasks = [
    makeTask({ id: "root" }),
    makeTask({ id: "a", links: [{ taskId: "root", type: "parent" }] }),
    makeTask({ id: "b", links: [{ taskId: "a", type: "parent" }] }),
    makeTask({ id: "free" }),
  ];

  it("rejects self-parenting", () => {
    expect(canReparent(tasks, "a", "a")).toBe(false);
  });

  it("rejects reparenting under a descendant (cycle)", () => {
    expect(canReparent(tasks, "a", "b")).toBe(false);
    expect(canReparent(tasks, "root", "b")).toBe(false);
  });

  it("allows reparenting an already-parented task (replace, not duplicate)", () => {
    expect(canReparent(tasks, "a", "free")).toBe(true);
    expect(canReparent(tasks, "b", "root")).toBe(true);
  });

  it("rejects empty ids (null-safe)", () => {
    expect(canReparent(tasks, "", "root")).toBe(false);
    expect(canReparent(tasks, "a", "")).toBe(false);
  });
});

describe("dragSession singleton", () => {
  it("get() starts null, begin(id) sets, end() clears", () => {
    dragSession.end();
    expect(dragSession.get()).toBeNull();
    dragSession.begin("drag-1");
    expect(dragSession.get()).toBe("drag-1");
    dragSession.begin("drag-2");
    expect(dragSession.get()).toBe("drag-2");
    dragSession.end();
    expect(dragSession.get()).toBeNull();
  });

  it('begin("") is ignored (null-safe)', () => {
    dragSession.end();
    dragSession.begin("");
    expect(dragSession.get()).toBeNull();
  });
});
