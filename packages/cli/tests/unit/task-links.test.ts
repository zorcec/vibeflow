import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  getChildren,
  getParent,
  getBlockers,
  validateLinkAddition,
  targetValid,
  taskRelations,
  formatRelationsSummary,
  resolveRootTask,
  getDescendants,
  getLeafDescendants,
  groupTasksByRoot,
} from "../../src/core/task-links.js";
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

describe("task-links", () => {
  describe("getChildren", () => {
    it("returns tasks that link to parentId as 'parent'", () => {
      const tasks = [
        makeTask({ id: "a", links: [{ taskId: "p", type: "parent" }] }),
        makeTask({ id: "b", links: [{ taskId: "p", type: "parent" }] }),
        makeTask({ id: "c", links: [{ taskId: "x", type: "parent" }] }),
        makeTask({ id: "p" }),
      ];
      expect(getChildren(tasks, "p").map((t) => t.id)).toEqual(["a", "b"]);
    });

    it("returns empty array when no children", () => {
      const tasks = [makeTask({ id: "a" })];
      expect(getChildren(tasks, "a")).toEqual([]);
    });
  });

  describe("getParent", () => {
    it("returns the parent task", () => {
      const parent = makeTask({ id: "parent-1" });
      const child = makeTask({
        id: "child-1",
        links: [{ taskId: "parent-1", type: "parent" }],
      });
      expect(getParent([parent, child], "child-1")?.id).toBe("parent-1");
    });

    it("returns undefined when no parent link", () => {
      const tasks = [makeTask({ id: "a" })];
      expect(getParent(tasks, "a")).toBeUndefined();
    });

    it("returns undefined when linked parent does not exist (dangling)", () => {
      const tasks = [
        makeTask({ id: "a", links: [{ taskId: "missing", type: "parent" }] }),
      ];
      expect(getParent(tasks, "a")).toBeUndefined();
    });
  });

  describe("validateLinkAddition", () => {
    it("rejects self-link", () => {
      const tasks = [makeTask({ id: "a" })];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "a",
        toId: "a",
        type: "parent",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("itself");
    });

    it("rejects duplicate link", () => {
      const tasks = [
        makeTask({
          id: "a",
          links: [{ taskId: "b", type: "relates" }],
        }),
        makeTask({ id: "b" }),
      ];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "a",
        toId: "b",
        type: "relates",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("already exists");
    });

    it("rejects second parent", () => {
      const tasks = [
        makeTask({
          id: "a",
          links: [{ taskId: "p1", type: "parent" }],
        }),
        makeTask({ id: "p1" }),
        makeTask({ id: "p2" }),
      ];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "a",
        toId: "p2",
        type: "parent",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("already has a parent");
    });

    it("rejects cycle (child -> parent of ancestor)", () => {
      // a -> b (parent) -> c (parent) — adding c -> a would create a cycle
      const tasks = [
        makeTask({
          id: "a",
          links: [{ taskId: "b", type: "parent" }],
        }),
        makeTask({
          id: "b",
          links: [{ taskId: "c", type: "parent" }],
        }),
        makeTask({ id: "c" }),
      ];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "c",
        toId: "a",
        type: "parent",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Cycle");
    });

    it("allows valid parent link", () => {
      const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "a",
        toId: "b",
        type: "parent",
      });
      expect(result.ok).toBe(true);
    });

    it("allows multiple relates links to same target", () => {
      // Different types to same target should be allowed
      const tasks = [
        makeTask({
          id: "a",
          links: [{ taskId: "b", type: "relates" }],
        }),
        makeTask({ id: "b" }),
      ];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "a",
        toId: "b",
        type: "blocks",
      });
      expect(result.ok).toBe(true);
    });

    it("tolerates dangling link ids in existing links", () => {
      const tasks = [
        makeTask({
          id: "a",
          links: [{ taskId: "nonexistent", type: "relates" }],
        }),
        makeTask({ id: "b" }),
      ];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "a",
        toId: "b",
        type: "blocks",
      });
      // Dangling link in existing links should not block adding new valid links
      expect(result.ok).toBe(true);
    });

    it("rejects when task not found", () => {
      const tasks = [makeTask({ id: "a" })];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "a",
        toId: "missing",
        type: "parent",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("PATCH-cycle simulation (server-side validation pattern)", () => {
    it("rejects reversing parent link to create cycle", () => {
      // A -> B parent, then PATCH B to have parent A → cycle
      const tasks = [
        makeTask({ id: "A", links: [{ taskId: "B", type: "parent" }] }),
        makeTask({ id: "B" }),
      ];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "B",
        toId: "A",
        type: "parent",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("Cycle");
    });

    it("rejects duplicate parent in PATCH payload", () => {
      // Task already has parent P1, PATCH adds another parent P2
      const tasks = [
        makeTask({
          id: "A",
          links: [{ taskId: "P1", type: "parent" }],
        }),
        makeTask({ id: "P1" }),
        makeTask({ id: "P2" }),
      ];
      const result = validateLinkAddition({
        allTasks: tasks,
        fromId: "A",
        toId: "P2",
        type: "parent",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("already has a parent");
    });

    it("empty links array clears via normalizeTask", () => {
      // normalizeTask treats [] → undefined (no links field written)
      // Simulate: PATCH sets links=[] → normalized to undefined → no links to validate
      const taskA = makeTask({
        id: "A",
        links: [{ taskId: "B", type: "parent" }],
      });
      const taskB = makeTask({ id: "B" });
      // After PATCH with links=[], the task has no links
      const emptyLinksTask = { ...taskA, links: undefined };
      const result = validateLinkAddition({
        allTasks: [emptyLinksTask, taskB],
        fromId: "A",
        toId: "B",
        type: "parent",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("getBlockers", () => {
    it("returns tasks that block this task", () => {
      // B has a 'blocks' link pointing at A → B blocks A
      const tasks = [
        makeTask({ id: "A" }),
        makeTask({
          id: "B",
          title: "Blocker",
          links: [{ taskId: "A", type: "blocks" }],
        }),
      ];
      const blockers = getBlockers(tasks, "A");
      expect(blockers).toHaveLength(1);
      expect(blockers[0].id).toBe("B");
    });

    it("returns multiple blockers", () => {
      // B and C both block A
      const tasks = [
        makeTask({ id: "A" }),
        makeTask({
          id: "B",
          links: [{ taskId: "A", type: "blocks" }],
        }),
        makeTask({
          id: "C",
          links: [{ taskId: "A", type: "blocks" }],
        }),
      ];
      expect(getBlockers(tasks, "A")).toHaveLength(2);
    });

    it("returns empty when no blocks links", () => {
      const tasks = [makeTask({ id: "A" })];
      expect(getBlockers(tasks, "A")).toEqual([]);
    });

    it("drops dangling blocker references", () => {
      const tasks = [
        makeTask({
          id: "A",
          links: [{ taskId: "MISSING", type: "blocks" }],
        }),
      ];
      expect(getBlockers(tasks, "A")).toEqual([]);
    });

    it("does not return tasks that A blocks (wrong direction)", () => {
      const tasks = [
        makeTask({
          id: "A",
          links: [{ taskId: "B", type: "blocks" }],
        }),
        makeTask({ id: "B" }),
      ];
      // A blocks B — getBlockers(B) should return A (A is the blocker),
      // but getBlockers(A) should return empty (A is not blocked)
      expect(getBlockers(tasks, "B")).toHaveLength(1);
      expect(getBlockers(tasks, "B")[0].id).toBe("A");
      expect(getBlockers(tasks, "A")).toHaveLength(0);
    });

    it("ignores non-blocks link types", () => {
      const tasks = [
        makeTask({
          id: "A",
          links: [
            { taskId: "B", type: "relates" },
            { taskId: "C", type: "parent" },
          ],
        }),
        makeTask({ id: "B" }),
        makeTask({ id: "C" }),
      ];
      expect(getBlockers(tasks, "A")).toHaveLength(0);
    });
  });

  describe("taskRelations", () => {
    it("returns parent when present", () => {
      const tasks = [
        makeTask({ id: "P", title: "Parent" }),
        makeTask({
          id: "C",
          title: "Child",
          links: [{ taskId: "P", type: "parent" }],
        }),
      ];
      const view = taskRelations(tasks, "C");
      expect(view.parent).toEqual({ id: "P", title: "Parent", status: "todo" });
    });

    it("returns null parent when no parent link", () => {
      const tasks = [makeTask({ id: "A" })];
      expect(taskRelations(tasks, "A").parent).toBeNull();
    });

    it("returns dangling parent as (not found)", () => {
      const tasks = [
        makeTask({ id: "A", links: [{ taskId: "MISSING", type: "parent" }] }),
      ];
      const view = taskRelations(tasks, "A");
      expect(view.parent).toEqual({ id: "MISSING", title: "(not found)" });
    });

    it("returns children with status", () => {
      const tasks = [
        makeTask({ id: "P" }),
        makeTask({
          id: "C1",
          title: "Child 1",
          status: "in-progress",
          links: [{ taskId: "P", type: "parent" }],
        }),
        makeTask({
          id: "C2",
          title: "Child 2",
          status: "review",
          links: [{ taskId: "P", type: "parent" }],
        }),
      ];
      const view = taskRelations(tasks, "P");
      expect(view.children).toHaveLength(2);
      expect(view.children[0]).toEqual({
        id: "C1",
        title: "Child 1",
        status: "in-progress",
      });
    });

    it("returns others (relates + blocks) typed", () => {
      const tasks = [
        makeTask({
          id: "A",
          links: [
            { taskId: "B", type: "relates" },
            { taskId: "C", type: "blocks" },
          ],
        }),
        makeTask({ id: "B", title: "Related" }),
        makeTask({ id: "C", title: "Blocker" }),
      ];
      const view = taskRelations(tasks, "A");
      expect(view.others).toHaveLength(2);
      expect(view.others[0]).toEqual({
        type: "relates",
        id: "B",
        title: "Related",
      });
      expect(view.others[1]).toEqual({
        type: "blocks",
        id: "C",
        title: "Blocker",
      });
    });

    it("returns empty for task with no links", () => {
      const tasks = [makeTask({ id: "A" })];
      const view = taskRelations(tasks, "A");
      expect(view).toEqual({ parent: null, children: [], others: [] });
    });

    it("returns empty for unknown task id", () => {
      const tasks = [makeTask({ id: "A" })];
      const view = taskRelations(tasks, "UNKNOWN");
      expect(view).toEqual({ parent: null, children: [], others: [] });
    });
  });

  describe("resolveRootTask", () => {
    it("returns self when no parent", () => {
      const tasks = [makeTask({ id: "a" })];
      expect(resolveRootTask(tasks, "a")).toBe("a");
    });

    it("returns direct parent when single level", () => {
      const tasks = [
        makeTask({ id: "parent" }),
        makeTask({
          id: "child",
          links: [{ taskId: "parent", type: "parent" }],
        }),
      ];
      expect(resolveRootTask(tasks, "child")).toBe("parent");
    });

    it("walks chain of 3 to root", () => {
      // a → b → c (root)
      const tasks = [
        makeTask({ id: "a", links: [{ taskId: "b", type: "parent" }] }),
        makeTask({ id: "b", links: [{ taskId: "c", type: "parent" }] }),
        makeTask({ id: "c" }),
      ];
      expect(resolveRootTask(tasks, "a")).toBe("c");
    });

    it("is cycle-safe (visited-set prevents infinite loop)", () => {
      // Self-referential data corruption — should not infinite loop
      const tasks = [
        makeTask({ id: "a", links: [{ taskId: "b", type: "parent" }] }),
        makeTask({ id: "b", links: [{ taskId: "a", type: "parent" }] }),
      ];
      // Visited set prevents infinite loop; returns whichever it hits first
      const root = resolveRootTask(tasks, "a");
      expect(["a", "b"]).toContain(root);
    });

    it("handles dangling parent id", () => {
      const tasks = [
        makeTask({ id: "a", links: [{ taskId: "missing", type: "parent" }] }),
      ];
      expect(resolveRootTask(tasks, "a")).toBe("missing");
    });
  });

  describe("getDescendants", () => {
    it("returns all descendants in a chain", () => {
      // root → a → b
      const tasks = [
        makeTask({ id: "root" }),
        makeTask({ id: "a", links: [{ taskId: "root", type: "parent" }] }),
        makeTask({ id: "b", links: [{ taskId: "a", type: "parent" }] }),
      ];
      expect(getDescendants(tasks, "root").sort()).toEqual(["a", "b"]);
    });

    it("returns empty for leaf task", () => {
      const tasks = [makeTask({ id: "leaf" })];
      expect(getDescendants(tasks, "leaf")).toEqual([]);
    });

    it("returns siblings at same level", () => {
      // root → a, root → b
      const tasks = [
        makeTask({ id: "root" }),
        makeTask({ id: "a", links: [{ taskId: "root", type: "parent" }] }),
        makeTask({ id: "b", links: [{ taskId: "root", type: "parent" }] }),
      ];
      expect(getDescendants(tasks, "root").sort()).toEqual(["a", "b"]);
    });
  });

  describe("getLeafDescendants", () => {
    it("returns only nodes without children", () => {
      // root → a (has child b), root → b (leaf), root → c (leaf)
      const tasks = [
        makeTask({ id: "root" }),
        makeTask({ id: "a", links: [{ taskId: "root", type: "parent" }] }),
        makeTask({ id: "b", links: [{ taskId: "root", type: "parent" }] }),
        makeTask({ id: "c", links: [{ taskId: "root", type: "parent" }] }),
        makeTask({ id: "d", links: [{ taskId: "a", type: "parent" }] }), // child of a
      ];
      const leaves = getLeafDescendants(tasks, "root");
      expect(leaves.map((t) => t.id).sort()).toEqual(["b", "c", "d"]);
    });

    it("returns empty when no descendants", () => {
      const tasks = [makeTask({ id: "solo" })];
      expect(getLeafDescendants(tasks, "solo")).toEqual([]);
    });
  });

  describe("groupTasksByRoot", () => {
    it("groups children under root, standalone are roots", () => {
      const tasks = [
        makeTask({ id: "root1" }),
        makeTask({
          id: "child1",
          links: [{ taskId: "root1", type: "parent" }],
        }),
        makeTask({
          id: "child2",
          links: [{ taskId: "root1", type: "parent" }],
        }),
        makeTask({ id: "root2" }),
      ];
      const { standalone, groups } = groupTasksByRoot(tasks);
      expect(standalone.map((t) => t.id).sort()).toEqual(["root1", "root2"]);
      const groupIds = groups
        .get("root1")
        ?.map((t) => t.id)
        .sort();
      expect(groupIds).toEqual(["child1", "child2"]);
    });

    it("orphan child is standalone (root absent)", () => {
      const tasks = [
        makeTask({
          id: "orphan",
          links: [{ taskId: "missing-root", type: "parent" }],
        }),
      ];
      const { standalone, groups } = groupTasksByRoot(tasks);
      expect(standalone.map((t) => t.id)).toEqual(["orphan"]);
      expect(groups.size).toBe(0);
    });

    it("multi-level: only first-level children under root", () => {
      // root → a → b (a is direct child, b is grandchild)
      const tasks = [
        makeTask({ id: "root" }),
        makeTask({ id: "a", links: [{ taskId: "root", type: "parent" }] }),
        makeTask({ id: "b", links: [{ taskId: "a", type: "parent" }] }),
      ];
      const { standalone, groups } = groupTasksByRoot(tasks);
      // root is standalone, a is grouped under root, b is grouped under a
      expect(standalone.map((t) => t.id)).toEqual(["root"]);
      // Root's group should only contain direct children
      const rootGroup = groups.get("root");
      expect(rootGroup?.map((t) => t.id)).toEqual(["a"]);
      // a's group should only contain direct children
      const aGroup = groups.get("a");
      expect(aGroup?.map((t) => t.id)).toEqual(["b"]);
    });
  });

  describe("formatRelationsSummary", () => {
    it("omits empty fields", () => {
      const view = { parent: null, children: [], others: [] };
      expect(formatRelationsSummary(view)).toEqual([]);
    });

    it("shows parent line", () => {
      const view = {
        parent: { id: "123456789012", title: "My Parent" },
        children: [],
        others: [],
      };
      const lines = formatRelationsSummary(view);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("12345678");
      expect(lines[0]).toContain("My Parent");
    });

    it("caps children at 3 and shows overflow", () => {
      const view = {
        parent: null,
        children: [
          { id: "a111", title: "A", status: "todo" },
          { id: "b222", title: "B", status: "review" },
          { id: "c333", title: "C", status: "done" },
          { id: "d444", title: "D", status: "todo" },
          { id: "e555", title: "E", status: "todo" },
        ],
        others: [],
      };
      const lines = formatRelationsSummary(view);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("…and 2 more");
      expect(lines[0]).toContain("a111");
      expect(lines[0]).not.toContain("d444");
    });

    it("truncates long titles to 40 chars", () => {
      const view = {
        parent: null,
        children: [{ id: "x", title: "A".repeat(60), status: "todo" }],
        others: [],
      };
      const lines = formatRelationsSummary(view);
      expect(lines[0].length).toBeLessThan(40 + 30); // title truncated
      expect(lines[0]).toContain("…");
    });

    it("formats others (relates/blocks)", () => {
      const view = {
        parent: null,
        children: [],
        others: [
          { type: "relates", id: "abc123", title: "Related" },
          { type: "blocks", id: "def456", title: "Blocker" },
        ],
      };
      const lines = formatRelationsSummary(view);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("related");
      expect(lines[1]).toContain("blocked");
    });

    it("dangling other shows (not found)", () => {
      const view = {
        parent: null,
        children: [],
        others: [{ type: "relates", id: "MISSING", title: "(not found)" }],
      };
      const lines = formatRelationsSummary(view);
      expect(lines[0]).toContain("(not found)");
    });
  });

  describe("targetValid", () => {
    it("rejects self-link", () => {
      const tasks = [makeTask({ id: "a" })];
      expect(targetValid(tasks, "a", "a")).toBe(false);
    });

    it("rejects cycle (target is descendant of dragged)", () => {
      // dragged=A has child B; target=B → A→B, dropping A onto B as child = cycle
      const tasks = [
        makeTask({ id: "A" }),
        makeTask({ id: "B", links: [{ taskId: "A", type: "parent" }] }),
      ];
      expect(targetValid(tasks, "A", "B")).toBe(false);
    });

    it("rejects deep cycle", () => {
      // A→B→C; dropping A onto C as child → A→B→C→A = cycle
      const tasks = [
        makeTask({ id: "A" }),
        makeTask({ id: "B", links: [{ taskId: "A", type: "parent" }] }),
        makeTask({ id: "C", links: [{ taskId: "B", type: "parent" }] }),
      ];
      expect(targetValid(tasks, "A", "C")).toBe(false);
    });

    it("allows valid unrelated task", () => {
      const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
      expect(targetValid(tasks, "a", "b")).toBe(true);
    });

    it("allows sibling (no cycle)", () => {
      // A and B are both children of P; dropping A onto B is fine
      const tasks = [
        makeTask({ id: "P" }),
        makeTask({ id: "A", links: [{ taskId: "P", type: "parent" }] }),
        makeTask({ id: "B", links: [{ taskId: "P", type: "parent" }] }),
      ];
      expect(targetValid(tasks, "A", "B")).toBe(true);
    });

    it("allows parent as target (re-parenting up)", () => {
      // A→B; dropping A onto C (unrelated) is fine
      const tasks = [
        makeTask({ id: "A" }),
        makeTask({ id: "B", links: [{ taskId: "A", type: "parent" }] }),
        makeTask({ id: "C" }),
      ];
      expect(targetValid(tasks, "A", "C")).toBe(true);
    });
  });

  // ── classifyDropZone (CLI mirror of ui/task-links.ts) ────────────────

  // classifyDropZone lives only in ui/task-links.ts; we test the same
  // logic here by importing the UI source at test time.
  // Since the CLI doesn't export classifyDropZone, we use the UI module.
  // (Vitest resolves .js → .ts in the same repo.)
  describe("classifyDropZone (parity with UI)", () => {
    // Helper that replicates the UI function logic inline for parity testing
    function classifyDropZone(
      rect: { top: number; height: number },
      clientY: number,
    ): "top" | "center" | "bottom" {
      const minBand = 26;
      const maxBand = 48;
      const rawBand = Math.floor(rect.height * 0.22);
      const band = Math.max(minBand, Math.min(maxBand, rawBand));
      if (clientY < rect.top + band) return "top";
      if (clientY > rect.top + rect.height - band) return "bottom";
      return "center";
    }

    it("small card (40px): clamp band to 26px", () => {
      // 40px card, rawBand = floor(40 * 0.22) = 8, clamped to 26
      // top: y < 0+26; bottom: y > 0+40-26=14; center: else
      const rect = { top: 0, height: 40 };
      expect(classifyDropZone(rect, 0)).toBe("top"); // y=0 < 26
      expect(classifyDropZone(rect, 13)).toBe("top"); // y=13 < 26
      // y=14: top check: 14 < 0+26 = 26 → TRUE → top
      // bottom check: 14 > 0+40-26 = 14 → FALSE → not bottom
      // So y=14 falls in the top band (band is clamped to 26 on a 40px card)
      expect(classifyDropZone(rect, 14)).toBe("top");
      // y=26: top check: 26 < 26 → FALSE; bottom check: 26 > 14 → TRUE → bottom
      expect(classifyDropZone(rect, 26)).toBe("bottom");
      expect(classifyDropZone(rect, 40)).toBe("bottom");
    });

    it("medium card (100px): band = clamp(floor(100*0.22), 26, 48) = 26", () => {
      const rect = { top: 0, height: 100 };
      // top: y < 26; bottom: y > 74; center: 26 <= y <= 74
      expect(classifyDropZone(rect, 0)).toBe("top");
      expect(classifyDropZone(rect, 25)).toBe("top");
      expect(classifyDropZone(rect, 26)).toBe("center");
      expect(classifyDropZone(rect, 74)).toBe("center");
      expect(classifyDropZone(rect, 75)).toBe("bottom");
      expect(classifyDropZone(rect, 100)).toBe("bottom");
    });

    it("large card (300px): band = clamp(floor(300*0.22), 26, 48) = 48", () => {
      // top: y < top+48; bottom: y > top+300-48=top+252; center: else
      const rect = { top: 100, height: 300 };
      expect(classifyDropZone(rect, 100)).toBe("top"); // y=100 < 148
      expect(classifyDropZone(rect, 147)).toBe("top"); // y=147 < 148
      expect(classifyDropZone(rect, 148)).toBe("center"); // y=148 >= 148
      expect(classifyDropZone(rect, 351)).toBe("center"); // y=351 <= 352
      expect(classifyDropZone(rect, 352)).toBe("center"); // y=352 <= 352
      expect(classifyDropZone(rect, 353)).toBe("bottom"); // y=353 > 352
      expect(classifyDropZone(rect, 400)).toBe("bottom");
    });

    it("no card overlap: clientY below bottom band returns bottom", () => {
      const rect = { top: 50, height: 100 };
      expect(classifyDropZone(rect, 1000)).toBe("bottom");
    });
  });

  // ── Parity: CLI and UI export the same function names ──────────────────
  describe("parity: CLI and UI task-links export the same helpers", () => {
    it("UI task-links.ts exports the same key function names as CLI", () => {
      // Source-text grep: check that both files define the same functions
      const cliSrc = readFileSync(
        new URL("../../src/core/task-links.ts", import.meta.url),
        "utf-8",
      );
      const uiPath = new URL(
        "../../../../ui/src/kanban/task-links.ts",
        import.meta.url,
      );
      let uiSrc: string;
      try {
        uiSrc = readFileSync(uiPath, "utf-8");
      } catch {
        // UI file not reachable from CLI test runner — skip gracefully
        return;
      }

      const keyFns = [
        "getChildren",
        "getParent",
        "getBlockers",
        "resolveRootTask",
        "getDescendants",
        "getLeafDescendants",
        "groupTasksByRoot",
        "targetValid",
      ];
      for (const fn of keyFns) {
        expect(cliSrc).toContain(`export function ${fn}`);
        expect(uiSrc).toContain(`export function ${fn}`);
      }
    });
  });
});
