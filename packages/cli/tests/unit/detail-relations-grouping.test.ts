import { describe, expect, it } from "vitest";
import { groupDetailRelations } from "@vibeflow-tools/ui/kanban";
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

describe("groupDetailRelations", () => {
  it("groups children (derived) and explicit links separately", () => {
    const parent = makeTask({ id: "parent-1" });
    const childA = makeTask({
      id: "child-a",
      links: [{ taskId: "parent-1", type: "parent" }],
    });
    const childB = makeTask({
      id: "child-b",
      links: [{ taskId: "parent-1", type: "parent" }],
    });
    const related = makeTask({ id: "rel-1" });
    const blocker = makeTask({ id: "block-1" });

    const parentWithLinks = makeTask({
      id: "parent-1",
      links: [
        { taskId: "rel-1", type: "relates" },
        { taskId: "block-1", type: "blocks" },
      ],
    });

    const allTasks = [parentWithLinks, childA, childB, related, blocker];
    const groups = groupDetailRelations(parentWithLinks, allTasks);

    // children are derived — tasks that have a parent link pointing at this task
    expect(groups.children.map((c) => c.id)).toEqual(["child-a", "child-b"]);
    // explicit links
    expect(groups.parentLinks).toHaveLength(0); // parent-1 has no "parent" type links
    expect(groups.relatesLinks).toHaveLength(1);
    expect(groups.relatesLinks[0].link.taskId).toBe("rel-1");
    expect(groups.blocksLinks).toHaveLength(1);
    expect(groups.blocksLinks[0].link.taskId).toBe("block-1");
  });

  it("returns empty groups for a task with no links and no children", () => {
    const task = makeTask({ id: "lonely" });
    const groups = groupDetailRelations(task, [task]);

    expect(groups.children).toHaveLength(0);
    expect(groups.parentLinks).toHaveLength(0);
    expect(groups.blocksLinks).toHaveLength(0);
    expect(groups.relatesLinks).toHaveLength(0);
  });

  it("preserves original link indices for removal", () => {
    const task = makeTask({
      id: "a",
      links: [
        { taskId: "b", type: "relates" },
        { taskId: "c", type: "blocks" },
        { taskId: "d", type: "relates" },
      ],
    });
    const b = makeTask({ id: "b" });
    const c = makeTask({ id: "c" });
    const d = makeTask({ id: "d" });

    const groups = groupDetailRelations(task, [task, b, c, d]);

    // relates links should have original indices 0 and 2
    expect(groups.relatesLinks).toHaveLength(2);
    expect(groups.relatesLinks[0].linkIndex).toBe(0);
    expect(groups.relatesLinks[0].link.taskId).toBe("b");
    expect(groups.relatesLinks[1].linkIndex).toBe(2);
    expect(groups.relatesLinks[1].link.taskId).toBe("d");

    // blocks link should have original index 1
    expect(groups.blocksLinks).toHaveLength(1);
    expect(groups.blocksLinks[0].linkIndex).toBe(1);
    expect(groups.blocksLinks[0].link.taskId).toBe("c");
  });

  it("marks dangling links (target not in allTasks)", () => {
    const task = makeTask({
      id: "a",
      links: [{ taskId: "missing", type: "relates" }],
    });

    const groups = groupDetailRelations(task, [task]);

    expect(groups.relatesLinks).toHaveLength(1);
    expect(groups.relatesLinks[0].target).toBeUndefined();
    expect(groups.relatesLinks[0].link.taskId).toBe("missing");
  });

  it("groups a 'parent' type link under parentLinks", () => {
    const task = makeTask({
      id: "a",
      links: [{ taskId: "b", type: "parent" }],
    });
    const b = makeTask({ id: "b" });

    const groups = groupDetailRelations(task, [task, b]);

    expect(groups.parentLinks).toHaveLength(1);
    expect(groups.parentLinks[0].link.taskId).toBe("b");
    expect(groups.parentLinks[0].link.type).toBe("parent");
  });

  it("handles task with undefined links gracefully", () => {
    const task = makeTask({ id: "a" });
    // links is undefined
    const groups = groupDetailRelations(task, [task]);

    expect(groups.children).toHaveLength(0);
    expect(groups.parentLinks).toHaveLength(0);
    expect(groups.blocksLinks).toHaveLength(0);
    expect(groups.relatesLinks).toHaveLength(0);
  });
});
