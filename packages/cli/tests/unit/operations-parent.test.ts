/**
 * Parent-on-create support for the operations layer (MCP `create_task`).
 *
 * `createTask` accepts an optional `parent` (full id or unique prefix), links
 * the new task beneath it in the same shape the `--set-parent` edit path
 * writes, and rejects a dangling target with the same wording.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  CreateTaskInput,
  type OperationContext,
} from "../../src/core/operations.js";
import { listTasks } from "../../src/core/tasks.js";
import type { Task } from "../../src/core/types.js";

let projectDir: string;

function ctx(): OperationContext {
  return { projectDir, mode: "local", userId: "Agent Smith" };
}

async function seedParent(title = "Parent"): Promise<Task> {
  const res = await createTask(ctx(), { title, description: "" });
  if (!res.ok || !res.data) throw new Error("failed to seed parent task");
  return res.data;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "create-parent-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("CreateTaskInput parent", () => {
  it("accepts input without parent", () => {
    const parsed = CreateTaskInput.parse({ title: "No parent" });
    expect(parsed.parent).toBeUndefined();
  });

  it("accepts an optional parent id", () => {
    const parsed = CreateTaskInput.parse({
      title: "With parent",
      parent: "abc123",
    });
    expect(parsed.parent).toBe("abc123");
  });
});

describe("createTask parent link", () => {
  it("links the new task under a full parent id", async () => {
    const parent = await seedParent();
    const res = await createTask(ctx(), {
      title: "Child",
      description: "",
      parent: parent.id,
    });

    expect(res.ok).toBe(true);
    expect(res.data?.links).toEqual([{ taskId: parent.id, type: "parent" }]);
    // Persisted, not just in the returned object.
    const stored = listTasks(projectDir).find((t) => t.id === res.data!.id);
    expect(stored?.links).toEqual([{ taskId: parent.id, type: "parent" }]);
  });

  it("resolves a unique id prefix", async () => {
    const parent = await seedParent();
    const res = await createTask(ctx(), {
      title: "Child",
      description: "",
      parent: parent.id.slice(0, 8),
    });

    expect(res.ok).toBe(true);
    expect(res.data?.links).toEqual([{ taskId: parent.id, type: "parent" }]);
  });

  it("rejects a dangling parent with the --set-parent wording", async () => {
    const res = await createTask(ctx(), {
      title: "Orphan",
      description: "",
      parent: "deadbeefdeadbeef",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("Parent task not found: deadbeefdeadbeef");
  });

  it("writes no task when the parent is dangling", async () => {
    expect(listTasks(projectDir)).toHaveLength(0);
    const res = await createTask(ctx(), {
      title: "Orphan",
      description: "",
      parent: "deadbeefdeadbeef",
    });

    expect(res.ok).toBe(false);
    expect(listTasks(projectDir)).toHaveLength(0);
  });

  it("omits the links field when no parent is given", async () => {
    const res = await createTask(ctx(), {
      title: "No parent",
      description: "",
    });

    expect(res.ok).toBe(true);
    expect(res.data?.links).toBeUndefined();
  });
});
