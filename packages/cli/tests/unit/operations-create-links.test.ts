/**
 * Links on create for the operations layer (MCP `create_task`).
 *
 * `create_task` accepts an optional `links` array with the same MERGE
 * semantics `update_task` has: every listed taskId+type pair is ADDED to the
 * new task, `parent` (when given) is folded into the same union, and a pair
 * named twice is a no-op. Every pair is validated through
 * `validateLinkAddition` — the same rule the update path reaches via
 * `buildAddLinks` — so a dangling target or a second `parent` is refused and
 * nothing is created. `links: []` is REFUSED (E_USAGE), exactly as on update.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  getTask,
  CreateTaskInput,
  type OperationContext,
} from "../../src/core/operations.js";
import { listTasks } from "../../src/core/tasks.js";
import type { Task } from "../../src/core/types.js";

let projectDir: string;

function ctx(): OperationContext {
  return { projectDir, mode: "local", userId: "Agent Smith" };
}

async function seed(title = "Seed"): Promise<Task> {
  const res = await createTask(ctx(), { title, description: "" });
  if (!res.ok || !res.data) throw new Error(`failed to seed task: ${title}`);
  return res.data;
}

function stored(id: string): Task | undefined {
  return listTasks(projectDir).find((t) => t.id === id);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "create-links-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("CreateTaskInput links schema", () => {
  it("accepts input without links", () => {
    const parsed = CreateTaskInput.parse({ title: "No links" });
    expect(parsed.links).toBeUndefined();
  });

  it("accepts an optional links array", () => {
    const parsed = CreateTaskInput.parse({
      title: "With links",
      links: [{ taskId: "abc123", type: "parent" }],
    });
    expect(parsed.links).toEqual([{ taskId: "abc123", type: "parent" }]);
  });

  it("refuses an unknown link type", () => {
    expect(() =>
      CreateTaskInput.parse({
        title: "Bad link",
        // SAFETY: intentionally invalid — asserts the schema rejects it.
        links: [{ taskId: "abc123", type: "child" }],
      }),
    ).toThrow();
  });
});

describe("createTask links merge", () => {
  it("creates a child via links and reads back parent/children", async () => {
    const parent = await seed("Parent");
    const res = await createTask(ctx(), {
      title: "Child",
      description: "",
      links: [{ taskId: parent.id, type: "parent" }],
    });
    expect(res.ok).toBe(true);
    const child = res.data!;
    expect(child.links).toEqual([{ taskId: parent.id, type: "parent" }]);

    // Read-back: the child reports its parent, the parent reports the child.
    const reread = await getTask(ctx(), { id: child.id });
    expect(reread.ok).toBe(true);
    expect((reread.data as unknown as { parent: { id: string } }).parent)
      .toMatchObject({ id: parent.id });
    const parentSide = await getTask(ctx(), { id: parent.id });
    expect(parentSide.ok).toBe(true);
    expect(
      (parentSide.data as unknown as { children: { id: string }[] }).children
        .map((c) => c.id),
    ).toContain(child.id);
  });

  it("creates blocks/relates links and reads them back", async () => {
    const blocker = await seed("Blocker");
    const related = await seed("Related");
    const res = await createTask(ctx(), {
      title: "Blocked",
      description: "",
      links: [
        { taskId: blocker.id, type: "blocks" },
        { taskId: related.id, type: "relates" },
      ],
    });
    expect(res.ok).toBe(true);
    const reread = await getTask(ctx(), { id: res.data!.id });
    expect(reread.ok).toBe(true);
    const others = (
      reread.data as unknown as {
        others: { type: string; id: string }[];
      }
    ).others;
    expect(others).toContainEqual(
      expect.objectContaining({ type: "blocks", id: blocker.id }),
    );
    expect(others).toContainEqual(
      expect.objectContaining({ type: "relates", id: related.id }),
    );
  });

  it("merges parent and links into one union", async () => {
    const parent = await seed("Parent");
    const blocker = await seed("Blocker");
    const res = await createTask(ctx(), {
      title: "Child",
      description: "",
      parent: parent.id,
      links: [{ taskId: blocker.id, type: "blocks" }],
    });
    expect(res.ok).toBe(true);
    expect(res.data!.links).toContainEqual({
      taskId: parent.id,
      type: "parent",
    });
    expect(res.data!.links).toContainEqual({
      taskId: blocker.id,
      type: "blocks",
    });
  });

  it("dedupes a parent named both ways instead of refusing", async () => {
    const parent = await seed("Parent");
    const res = await createTask(ctx(), {
      title: "Child",
      description: "",
      parent: parent.id,
      links: [{ taskId: parent.id, type: "parent" }],
    });
    expect(res.ok).toBe(true);
    expect(
      res.data!.links!.filter((l) => l.type === "parent"),
    ).toHaveLength(1);
  });

  it("resolves link prefixes like parent does", async () => {
    const parent = await seed("Parent");
    const res = await createTask(ctx(), {
      title: "Child",
      description: "",
      links: [{ taskId: parent.id.slice(0, 8), type: "parent" }],
    });
    expect(res.ok).toBe(true);
    expect(res.data!.links).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });

  it("refuses links: [] with E_USAGE and creates nothing", async () => {
    const before = listTasks(projectDir).length;
    const res = await createTask(ctx(), {
      title: "Empty links",
      description: "",
      links: [],
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_USAGE");
    expect(res.error?.suggestion).toBeTruthy();
    expect(listTasks(projectDir)).toHaveLength(before);
  });

  it("refuses a dangling link target and creates nothing", async () => {
    const before = listTasks(projectDir).length;
    const res = await createTask(ctx(), {
      title: "Dangling",
      description: "",
      links: [{ taskId: "does-not-exist", type: "parent" }],
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("TASK_NOT_FOUND");
    expect(listTasks(projectDir)).toHaveLength(before);
  });

  it("refuses two different parents and creates nothing", async () => {
    const first = await seed("First");
    const second = await seed("Second");
    const before = listTasks(projectDir).length;
    const res = await createTask(ctx(), {
      title: "Two parents",
      description: "",
      parent: first.id,
      links: [{ taskId: second.id, type: "parent" }],
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_USAGE");
    expect(listTasks(projectDir)).toHaveLength(before);
  });

  it("keeps creating unlinked tasks when links are omitted", async () => {
    const res = await createTask(ctx(), { title: "Root", description: "" });
    expect(res.ok).toBe(true);
    expect(stored(res.data!.id)!.links ?? []).toEqual([]);
  });
});
