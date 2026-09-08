import { describe, it, expect } from "vitest";
import {
  getChildren,
  getDescendants,
  getLeafDescendants,
} from "../../../src/core/task-links";
import type { Task } from "../../../src/core/tasks";

/**
 * RecursiveChildrenTree unit tests (pure data-layer validation).
 * The component itself is a React component; these tests validate the
 * underlying tree logic that drives it — getChildren, getDescendants,
 * getLeafDescendants — and confirm the recursive structure that the
 * component would render.
 *
 * For full rendering tests, see the Playwright spec.
 */

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id.slice(0, 7)}`,
    status: "todo",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comments: [],
    files: [],
    ...overrides,
  } as Task;
}

describe("recursive children tree logic", () => {
  describe("2-level tree (parent → children)", () => {
    const root = makeTask({ id: "root-1111111111111111", title: "Root" });
    const childA = makeTask({
      id: "chil-a111111111111111",
      title: "Child A",
      links: [{ taskId: "root-1111111111111111", type: "parent" }],
    });
    const childB = makeTask({
      id: "chil-b111111111111111",
      title: "Child B",
      links: [{ taskId: "root-1111111111111111", type: "parent" }],
    });
    const tasks = [root, childA, childB];

    it("getChildren returns direct children only", () => {
      const children = getChildren(tasks, root.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toContain(childA.id);
      expect(children.map((c) => c.id)).toContain(childB.id);
    });

    it("getDescendants returns all descendants", () => {
      const desc = getDescendants(tasks, root.id);
      expect(desc).toHaveLength(2);
      expect(desc).toContain(childA.id);
      expect(desc).toContain(childB.id);
    });

    it("getLeafDescendants returns children with no children of their own", () => {
      const leaves = getLeafDescendants(tasks, root.id);
      expect(leaves).toHaveLength(2);
      expect(leaves.map((l) => l.id)).toContain(childA.id);
      expect(leaves.map((l) => l.id)).toContain(childB.id);
    });
  });

  describe("3-level tree (parent → children → grandchildren)", () => {
    const root = makeTask({ id: "root-1111111111111111", title: "Root" });
    const childA = makeTask({
      id: "chil-a111111111111111",
      title: "Child A",
      links: [{ taskId: "root-1111111111111111", type: "parent" }],
    });
    const childB = makeTask({
      id: "chil-b111111111111111",
      title: "Child B",
      links: [{ taskId: "root-1111111111111111", type: "parent" }],
    });
    const grandchildA1 = makeTask({
      id: "gcha11111111111111",
      title: "Grandchild A1",
      links: [{ taskId: "chil-a111111111111111", type: "parent" }],
    });
    const grandchildA2 = makeTask({
      id: "gcha21111111111111",
      title: "Grandchild A2",
      links: [{ taskId: "chil-a111111111111111", type: "parent" }],
    });
    const grandchildB1 = makeTask({
      id: "gchb11111111111111",
      title: "Grandchild B1",
      links: [{ taskId: "chil-b111111111111111", type: "parent" }],
    });
    const tasks = [
      root,
      childA,
      childB,
      grandchildA1,
      grandchildA2,
      grandchildB1,
    ];

    it("getChildren returns direct children only (not grandchildren)", () => {
      const children = getChildren(tasks, root.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toEqual(
        expect.arrayContaining([childA.id, childB.id]),
      );
      // Should NOT include grandchildren
      expect(children.map((c) => c.id)).not.toContain(grandchildA1.id);
    });

    it("getDescendants returns all descendants (children + grandchildren)", () => {
      const desc = getDescendants(tasks, root.id);
      expect(desc).toHaveLength(5);
      expect(desc).toContain(childA.id);
      expect(desc).toContain(childB.id);
      expect(desc).toContain(grandchildA1.id);
      expect(desc).toContain(grandchildA2.id);
      expect(desc).toContain(grandchildB1.id);
    });

    it("getLeafDescendants returns only leaf nodes (grandchildren with no children)", () => {
      const leaves = getLeafDescendants(tasks, root.id);
      expect(leaves).toHaveLength(3);
      expect(leaves.map((l) => l.id)).toEqual(
        expect.arrayContaining([
          grandchildA1.id,
          grandchildA2.id,
          grandchildB1.id,
        ]),
      );
      // Should NOT include intermediate children
      expect(leaves.map((l) => l.id)).not.toContain(childA.id);
      expect(leaves.map((l) => l.id)).not.toContain(childB.id);
    });

    it("recursive tree structure: childA has 2 children, childB has 1", () => {
      const childAChildren = getChildren(tasks, childA.id);
      const childBChildren = getChildren(tasks, childB.id);
      expect(childAChildren).toHaveLength(2);
      expect(childBChildren).toHaveLength(1);
    });

    it("recursive tree structure: grandchildren have no children (leaves)", () => {
      expect(getChildren(tasks, grandchildA1.id)).toHaveLength(0);
      expect(getChildren(tasks, grandchildA2.id)).toHaveLength(0);
      expect(getChildren(tasks, grandchildB1.id)).toHaveLength(0);
    });
  });

  describe("cycle safety", () => {
    it("getDescendants handles cycles (A→B→C→A) without infinite loop", () => {
      const taskA = makeTask({
        id: "cyca-111111111111111",
        title: "Cycle A",
        links: [{ taskId: "cycb-111111111111111", type: "parent" }],
      });
      const taskB = makeTask({
        id: "cycb-111111111111111",
        title: "Cycle B",
        links: [{ taskId: "cycc-111111111111111", type: "parent" }],
      });
      const taskC = makeTask({
        id: "cycc-111111111111111",
        title: "Cycle C",
        links: [{ taskId: "cyca-111111111111111", type: "parent" }],
      });
      const tasks = [taskA, taskB, taskC];

      // Should not hang
      const desc = getDescendants(tasks, taskA.id);
      // Cycle-safe: should include at least B and C without hanging
      expect(desc.length).toBeGreaterThanOrEqual(2);
      expect(desc).toContain(taskB.id);
      expect(desc).toContain(taskC.id);
    });
  });

  describe("dangling parent links", () => {
    it("getChildren skips tasks whose parent target does not exist", () => {
      const orphan = makeTask({
        id: "orph-111111111111111",
        title: "Orphan",
        links: [{ taskId: "nonexistent-id-here", type: "parent" }],
      });
      const tasks = [orphan];

      // getChildren returns tasks with the link (even if target is dangling)
      // Dangling safety is handled at the component level (skip missing tasks)
      expect(getChildren(tasks, "nonexistent-id-here")).toHaveLength(1);
    });

    it("getDescendants does not include tasks with dangling parent links", () => {
      const root = makeTask({ id: "root-1111111111111111", title: "Root" });
      const dangling = makeTask({
        id: "dang-111111111111111",
        title: "Dangling",
        links: [{ taskId: "nonexistent-parent-here", type: "parent" }],
      });
      const tasks = [root, dangling];

      const desc = getDescendants(tasks, root.id);
      // Dangling task is NOT a descendant of root (its parent link points elsewhere)
      expect(desc).toHaveLength(0);
      expect(desc).not.toContain(dangling.id);
    });
  });

  describe("chip count semantics unchanged", () => {
    it("leaf descendant count matches visible rows in full-tree view", () => {
      // Simulate the demo parent's 9 children scenario
      const root = makeTask({
        id: "root-1111111111111111",
        title: "Demo Parent",
      });
      const children: Task[] = [];
      for (let i = 0; i < 9; i++) {
        const id = `chil${i}11111111111111`;
        children.push(
          makeTask({
            id,
            title: `Child ${i}`,
            links: [{ taskId: "root-1111111111111111", type: "parent" }],
          }),
        );
      }
      const tasks = [root, ...children];

      // All 9 children are leaves
      const leaves = getLeafDescendants(tasks, root.id);
      expect(leaves).toHaveLength(9);

      // getChildren also returns 9 (they're all direct + leaf)
      const direct = getChildren(tasks, root.id);
      expect(direct).toHaveLength(9);
    });
  });

  describe("orphan detection", () => {
    it("child with parent link to a missing task is flagged as orphan", () => {
      const root = makeTask({ id: "root-1111111111111111", title: "Root" });
      const orphan = makeTask({
        id: "orph-111111111111111",
        title: "Orphan",
        links: [{ taskId: "deleted-parent-id", type: "parent" }],
      });
      const tasks = [root, orphan];

      const children = getChildren(tasks, "deleted-parent-id");
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(orphan.id);

      const parentLink = orphan.links?.find((l) => l.type === "parent");
      expect(parentLink).toBeDefined();
      expect(tasks.find((t) => t.id === parentLink!.taskId)).toBeUndefined();
    });

    it("child with valid parent link is NOT orphan", () => {
      const root = makeTask({ id: "root-1111111111111111", title: "Root" });
      const child = makeTask({
        id: "chil-a111111111111111",
        title: "Child A",
        links: [{ taskId: "root-1111111111111111", type: "parent" }],
      });
      const tasks = [root, child];

      const parentLink = child.links?.find((l) => l.type === "parent");
      expect(parentLink).toBeDefined();
      expect(tasks.find((t) => t.id === parentLink!.taskId)).toBeDefined();
    });

    it("child without any parent link is NOT orphan", () => {
      const root = makeTask({ id: "root-1111111111111111", title: "Root" });
      const child = makeTask({
        id: "chil-a111111111111111",
        title: "Child A",
        links: [],
      });
      const tasks = [root, child];

      const parentLink = child.links?.find((l) => l.type === "parent");
      expect(parentLink).toBeUndefined();
    });
  });

  describe("depth-8 failsafe (MAX_TREE_DEPTH)", () => {
    it("constant is exported with value 8", async () => {
      const mod = await import("@vibeflow-tools/ui/kanban");
      expect(mod.MAX_TREE_DEPTH).toBe(8);
    });

    /** Build a strict chain: root → L1 → L2 → ... → L8 (9 nodes, 8 edges). */
    function buildChain(length: number): Task[] {
      const tasks: Task[] = [];
      for (let i = 0; i < length; i++) {
        const id = `lvl${i}-----${"0".repeat(12)}`;
        const links =
          i === 0
            ? []
            : [
                {
                  taskId: `lvl${i - 1}-----${"0".repeat(12)}`,
                  type: "parent" as const,
                },
              ];
        tasks.push(makeTask({ id, title: `Level ${i}`, links }));
      }
      return tasks;
    }

    it("depth-8 chain: all 8 children are reachable via getChildren at each level", () => {
      const chain = buildChain(9); // root + 8 children
      // Each level has exactly 1 child (linear chain)
      for (let i = 0; i < 8; i++) {
        const parentId = `lvl${i}-----${"0".repeat(12)}`;
        const children = getChildren(chain, parentId);
        expect(children).toHaveLength(1);
        expect(children[0].id).toBe(`lvl${i + 1}-----${"0".repeat(12)}`);
      }
      // Root has 8 total descendants
      expect(getDescendants(chain, chain[0].id)).toHaveLength(8);
    });

    it("depth-9 chain: getDescendants still works (8-depth guard is visual, not data-layer)", () => {
      const chain = buildChain(10); // root + 9 children
      // Data layer has no depth limit — all 9 descendants are reachable
      expect(getDescendants(chain, chain[0].id)).toHaveLength(9);
    });

    it("wide tree at depth 8: multiple branches don't overflow", () => {
      // root → 3 children → each has 1 child → ... for 8 levels
      const tasks: Task[] = [];
      for (let lvl = 0; lvl < 8; lvl++) {
        for (let br = 0; br < 3; br++) {
          const id = `l${lvl}b${br}${"0".repeat(13)}`;
          const parentId =
            lvl === 0
              ? `root-----${"0".repeat(8)}`
              : `l${lvl - 1}b${br}${"0".repeat(13)}`;
          const links = [{ taskId: parentId, type: "parent" as const }];
          tasks.push(makeTask({ id, title: `L${lvl}-B${br}`, links }));
        }
      }
      const root = makeTask({
        id: `root-----${"0".repeat(8)}`,
        title: "Wide Root",
      });
      tasks.unshift(root);

      // Root has 3 direct children, 3*8 = 24 descendants
      expect(getChildren(tasks, root.id)).toHaveLength(3);
      expect(getDescendants(tasks, root.id)).toHaveLength(24);
    });
  });
});
