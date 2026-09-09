import { describe, expect, it } from "vitest";
import { buildSetParentLinks } from "../../src/core/task-links.js";
import type { Task } from "../../src/core/types.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "todo",
    selector: overrides.selector ?? "/",
    created: overrides.created ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildSetParentLinks (--set-parent)", () => {
  it("sets a parent link on a task with no links", () => {
    const tasks = [makeTask({ id: "child" }), makeTask({ id: "parent" })];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "child",
      parentId: "parent",
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.links).toEqual([{ taskId: "parent", type: "parent" }]);
  });

  it("errors when the parent task does not exist", () => {
    const tasks = [makeTask({ id: "child" })];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "child",
      parentId: "missing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Parent task not found");
  });

  it("replaces an existing parent with a different one", () => {
    const tasks = [
      makeTask({
        id: "child",
        links: [{ taskId: "old-parent", type: "parent" }],
      }),
      makeTask({ id: "old-parent" }),
      makeTask({ id: "new-parent" }),
    ];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "child",
      parentId: "new-parent",
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.links).toEqual([{ taskId: "new-parent", type: "parent" }]);
  });

  it("setting the same parent again is a no-op success", () => {
    const tasks = [
      makeTask({
        id: "child",
        links: [{ taskId: "parent", type: "parent" }],
      }),
      makeTask({ id: "parent" }),
    ];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "child",
      parentId: "parent",
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.links).toEqual([{ taskId: "parent", type: "parent" }]);
  });

  it("clears the parent link but keeps relates/blocks links", () => {
    const tasks = [
      makeTask({
        id: "child",
        links: [
          { taskId: "parent", type: "parent" },
          { taskId: "other", type: "relates" },
        ],
      }),
      makeTask({ id: "parent" }),
      makeTask({ id: "other" }),
    ];
    for (const parentId of [null, "", undefined]) {
      const result = buildSetParentLinks({
        allTasks: tasks,
        taskId: "child",
        parentId,
      });
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.links).toEqual([{ taskId: "other", type: "relates" }]);
    }
  });

  it("clearing the last link returns undefined (no links field)", () => {
    const tasks = [
      makeTask({
        id: "child",
        links: [{ taskId: "parent", type: "parent" }],
      }),
      makeTask({ id: "parent" }),
    ];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "child",
      parentId: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.links).toBeUndefined();
  });

  it("rejects setting a task as its own parent", () => {
    const tasks = [makeTask({ id: "a" })];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "a",
      parentId: "a",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("itself");
  });

  it("rejects a parent that is a descendant (cycle)", () => {
    // child -> parent; setting parent's parent to child would cycle
    const tasks = [
      makeTask({
        id: "child",
        links: [{ taskId: "parent", type: "parent" }],
      }),
      makeTask({ id: "parent" }),
    ];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "parent",
      parentId: "child",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Cycle");
  });

  it("errors when the edited task does not exist", () => {
    const tasks = [makeTask({ id: "parent" })];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "ghost",
      parentId: "parent",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Task not found");
  });

  it("preserves relates/blocks links when setting a parent", () => {
    const tasks = [
      makeTask({
        id: "child",
        links: [{ taskId: "other", type: "blocks" }],
      }),
      makeTask({ id: "parent" }),
      makeTask({ id: "other" }),
    ];
    const result = buildSetParentLinks({
      allTasks: tasks,
      taskId: "child",
      parentId: "parent",
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.links).toEqual([
        { taskId: "other", type: "blocks" },
        { taskId: "parent", type: "parent" },
      ]);
  });
});
