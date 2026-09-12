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
  canDropAsChild,
  computeTreeReorder,
  targetValid,
  dragSession,
} from "../task-links";
import { compareTaskOrder } from "../utils";
import type { ReorderPatch } from "../utils";
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
  // 200px row → tree bands clamped to [5px, 10px].
  // Top band [0,10), bottom [190,200], center [10,190).
  const rect = { top: 100, height: 200 };
  const child = { id: "c1" };

  it("top band → tree-row before", () => {
    // y=105 is within top+10px band
    expect(classifyTreeRowIntent(rect, 105, child, "p1")).toEqual({
      kind: "tree-row",
      targetId: "c1",
      parentId: "p1",
      position: "before",
    });
  });

  it("bottom band → tree-row after", () => {
    // y=295 is within bottom-10px band (top+190)
    expect(classifyTreeRowIntent(rect, 295, child, "p1")).toEqual({
      kind: "tree-row",
      targetId: "c1",
      parentId: "p1",
      position: "after",
    });
  });

  it("center → zone intent with fromTree flag (make-child of the row's task)", () => {
    // y=200 is in center band (10px < y < 190px from top)
    expect(classifyTreeRowIntent(rect, 200, child, "p1")).toEqual({
      kind: "zone",
      parentId: "c1",
      fromTree: true,
    });
  });

  it("returns null when the row task has no id (null-safe)", () => {
    expect(classifyTreeRowIntent(rect, 200, null, "p1")).toBeNull();
    expect(
      classifyTreeRowIntent(rect, 200, {} as { id?: string }, "p1"),
    ).toBeNull();
  });

  it("clamps small-row bands to tree-specific 5px min (center reachable)", () => {
    // 22px row → raw band ~6px → clamped to [5,10]: y=top+4 is top,
    // y=top+6 is center, y=top+18 is bottom.
    const small = { top: 0, height: 22 };
    expect(classifyTreeRowIntent(small, 4, child, "p1")?.position).toBe(
      "before",
    );
    const centerIntent = classifyTreeRowIntent(small, 11, child, "p1");
    expect(centerIntent?.kind).toBe("zone");
    expect(centerIntent).toHaveProperty("fromTree", true);
    expect(classifyTreeRowIntent(small, 20, child, "p1")?.position).toBe(
      "after",
    );
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

describe("canDropAsChild (link OR reparent)", () => {
  const tasks = [
    makeTask({ id: "root" }),
    makeTask({ id: "a", links: [{ taskId: "root", type: "parent" }] }),
    makeTask({ id: "grandchild", links: [{ taskId: "a", type: "parent" }] }),
    makeTask({ id: "free" }),
  ];

  it("allows a parentless task (link path)", () => {
    expect(canDropAsChild(tasks, "free", "root")).toBe(true);
  });

  it("allows an already-parented task (reparent path)", () => {
    // Single-parent rule rejects the link, but the move must still be offered.
    expect(targetValid(tasks, "a", "free")).toBe(false);
    expect(canDropAsChild(tasks, "a", "free")).toBe(true);
  });

  it("allows moving a nested child back to a higher ancestor", () => {
    expect(canDropAsChild(tasks, "grandchild", "root")).toBe(true);
  });

  it("rejects self and descendant targets", () => {
    expect(canDropAsChild(tasks, "a", "a")).toBe(false);
    expect(canDropAsChild(tasks, "a", "grandchild")).toBe(false);
  });

  it("rejects empty ids (null-safe)", () => {
    expect(canDropAsChild(tasks, "", "root")).toBe(false);
    expect(canDropAsChild(tasks, "a", "")).toBe(false);
  });
});

describe("computeTreeReorder (sibling order plan)", () => {
  function siblingOrder(tasks: Task[], parentId: string): string[] {
    return tasks
      .filter((t) =>
        t?.links?.some((l) => l?.type === "parent" && l?.taskId === parentId),
      )
      .sort(compareTaskOrder)
      .map((t) => t.id);
  }

  /** Apply a plan exactly like the CLI kanban does (dragged key + patches). */
  function applyPlan(
    tasks: Task[],
    draggedId: string,
    plan: { newSortKey: string; normalizationPatches: ReorderPatch[] },
  ): Task[] {
    const keys = new Map(
      plan.normalizationPatches.map((p) => [p.id, p.sortKey] as const),
    );
    keys.set(draggedId, plan.newSortKey);
    return tasks.map((t) =>
      keys.has(t.id) ? { ...t, sortKey: keys.get(t.id) } : t,
    );
  }

  const keyless = [
    makeTask({ id: "r", updatedAt: "2026-01-01" }),
    makeTask({
      id: "a",
      updatedAt: "2026-01-02",
      links: [{ taskId: "r", type: "parent" }],
    }),
    makeTask({
      id: "b",
      updatedAt: "2026-01-03",
      links: [{ taskId: "r", type: "parent" }],
    }),
  ];

  it("keyless siblings: a plan exists and applying it yields the intended order", () => {
    expect(siblingOrder(keyless, "r")).toEqual(["a", "b"]);
    const plan = computeTreeReorder(keyless, "a", "r", "b", "after");
    expect(plan).not.toBeNull();
    // The keyless neighbour must be re-keyed, otherwise compareTaskOrder keeps
    // it after every keyed task and the drag appears to do nothing.
    expect(plan!.normalizationPatches.map((p) => p.id)).toContain("b");
    const next = applyPlan(keyless, "a", plan!);
    expect(siblingOrder(next, "r")).toEqual(["b", "a"]);
  });

  it("keyless siblings: drag the middle sibling before the first", () => {
    const plan = computeTreeReorder(keyless, "b", "r", "a", "before");
    const next = applyPlan(keyless, "b", plan!);
    expect(siblingOrder(next, "r")).toEqual(["b", "a"]);
  });

  it("fully keyed siblings need no normalization patches", () => {
    const keyed = [
      makeTask({ id: "r" }),
      makeTask({
        id: "a",
        sortKey: "0000000001000000",
        links: [{ taskId: "r", type: "parent" }],
      }),
      makeTask({
        id: "b",
        sortKey: "0000000002000000",
        links: [{ taskId: "r", type: "parent" }],
      }),
    ];
    const plan = computeTreeReorder(keyed, "a", "r", "b", "after");
    expect(plan!.normalizationPatches).toEqual([]);
    const next = applyPlan(keyed, "a", plan!);
    expect(siblingOrder(next, "r")).toEqual(["b", "a"]);
  });

  it("appends last when there is no target (zone/children-zone drop)", () => {
    const plan = computeTreeReorder(keyless, "a", "r", null, "after");
    const next = applyPlan(keyless, "a", plan!);
    expect(siblingOrder(next, "r")).toEqual(["b", "a"]);
  });

  // Regression: the only child (or a parent with no other children) is a
  // no-neighbour drop too. It must anchor after the store max, not mint the
  // store's initial constant `0000000001000000` (a cross-column duplicate).
  it("anchors an only-child reorder after the store max, not the constant", () => {
    const only = [
      makeTask({ id: "r" }),
      makeTask({
        id: "a",
        sortKey: "0000024263628904",
        links: [{ taskId: "r", type: "parent" }],
      }),
    ];
    const plan = computeTreeReorder(only, "a", "r", null, "after");
    expect(plan).not.toBeNull();
    expect(plan!.newSortKey).not.toBe("0000000001000000");
    expect(plan!.newSortKey > "0000024263628904").toBe(true);
  });

  it("appends last when the target is not among the siblings", () => {
    const plan = computeTreeReorder(keyless, "a", "r", "missing", "after");
    const next = applyPlan(keyless, "a", plan!);
    expect(siblingOrder(next, "r")).toEqual(["b", "a"]);
  });

  it("returns null for missing ids (null-safe)", () => {
    expect(computeTreeReorder(keyless, "", "r", "b", "after")).toBeNull();
    expect(computeTreeReorder(keyless, "a", "", "b", "after")).toBeNull();
  });
});
