/**
 * Links support for the operations layer (MCP `update_task`).
 *
 * `updateTask` accepts an optional `links` array with replace semantics
 * (empty array clears every link) and validates each link against the
 * post-replace state using the same helpers/wording as `--set-parent`:
 * self-link, dangling target, duplicate and cycle are rejected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  updateTask,
  UpdateTaskInput,
  type OperationContext,
} from "../../src/core/operations.js";
import { listTasks } from "../../src/core/tasks.js";
import type { Task } from "../../src/core/types.js";

let projectDir: string;

function ctx(): OperationContext {
  return { projectDir, mode: "local", userId: "Agent Smith" };
}

async function seed(title: string): Promise<Task> {
  const res = await createTask(ctx(), { title, description: "" });
  if (!res.ok || !res.data) throw new Error(`failed to seed task: ${title}`);
  return res.data;
}

function stored(id: string): Task | undefined {
  return listTasks(projectDir).find((t) => t.id === id);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "update-links-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("UpdateTaskInput links schema", () => {
  it("accepts an optional links array", () => {
    const parsed = UpdateTaskInput.parse({
      id: "abc",
      links: [{ taskId: "def", type: "parent" }],
    });
    expect(parsed.links).toEqual([{ taskId: "def", type: "parent" }]);
  });

  it("accepts an empty array (clear)", () => {
    const parsed = UpdateTaskInput.parse({ id: "abc", links: [] });
    expect(parsed.links).toEqual([]);
  });

  it("defaults links to undefined when omitted", () => {
    expect(UpdateTaskInput.parse({ id: "abc" }).links).toBeUndefined();
  });

  it("rejects an unknown link type", () => {
    expect(() =>
      UpdateTaskInput.parse({
        id: "abc",
        links: [{ taskId: "def", type: "sibling" }],
      }),
    ).toThrow();
  });
});

describe("updateTask links", () => {
  it("persists a parent link on disk", async () => {
    const parent = await seed("Parent");
    const child = await seed("Child");

    const res = await updateTask(ctx(), {
      id: child.id,
      links: [{ taskId: parent.id, type: "parent" }],
    });

    expect(res.ok).toBe(true);
    expect(stored(child.id)?.links).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });

  it("replaces the whole link set (a swap drops links not in the payload)", async () => {
    const parent = await seed("Parent");
    const other = await seed("Other");
    const task = await seed("Task");

    await updateTask(ctx(), {
      id: task.id,
      links: [
        { taskId: parent.id, type: "parent" },
        { taskId: other.id, type: "relates" },
      ],
    });
    const res = await updateTask(ctx(), {
      id: task.id,
      links: [{ taskId: parent.id, type: "parent" }],
    });

    expect(res.ok).toBe(true);
    expect(stored(task.id)?.links).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });

  it("rejects a self-link", async () => {
    const task = await seed("Task");

    const res = await updateTask(ctx(), {
      id: task.id,
      links: [{ taskId: task.id, type: "parent" }],
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("Cannot link a task to itself");
    expect(stored(task.id)?.links).toBeUndefined();
  });

  it("rejects a dangling target", async () => {
    const task = await seed("Task");

    const res = await updateTask(ctx(), {
      id: task.id,
      links: [{ taskId: "deadbeefdeadbeef", type: "relates" }],
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("Task deadbeefdeadbeef not found");
    expect(stored(task.id)?.links).toBeUndefined();
  });

  it("rejects a duplicate link within the payload", async () => {
    const a = await seed("A");
    const b = await seed("B");

    const res = await updateTask(ctx(), {
      id: a.id,
      links: [
        { taskId: b.id, type: "relates" },
        { taskId: b.id, type: "relates" },
      ],
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe(
      `Link already exists: ${a.id} --[relates]--> ${b.id}`,
    );
    expect(stored(a.id)?.links).toBeUndefined();
  });

  it("rejects a cycle (an update can create one)", async () => {
    const a = await seed("A");
    const b = await seed("B");
    const c = await seed("C");
    // b is a child of a; c is a child of b.
    await updateTask(ctx(), {
      id: b.id,
      links: [{ taskId: a.id, type: "parent" }],
    });
    await updateTask(ctx(), {
      id: c.id,
      links: [{ taskId: b.id, type: "parent" }],
    });

    // Making a a child of c would close the loop.
    const res = await updateTask(ctx(), {
      id: a.id,
      links: [{ taskId: c.id, type: "parent" }],
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe(
      `Cycle detected: ${c.id} is already a descendant of ${a.id}`,
    );
    expect(stored(a.id)?.links).toBeUndefined();
  });

  it("clears every link with an empty array", async () => {
    const parent = await seed("Parent");
    const task = await seed("Task");
    await updateTask(ctx(), {
      id: task.id,
      links: [{ taskId: parent.id, type: "parent" }],
    });
    expect(stored(task.id)?.links).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);

    const res = await updateTask(ctx(), { id: task.id, links: [] });

    expect(res.ok).toBe(true);
    expect(stored(task.id)?.links).toBeUndefined();
  });
});
