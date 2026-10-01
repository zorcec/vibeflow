/**
 * Links support for the operations layer (MCP `update_task`).
 *
 * `updateTask` accepts an optional `links` array with MERGE semantics, matching
 * the CLI's surgical `--relates` / `--blocks`: every listed pair is added, a
 * pair already present is a no-op (so a repeat send is idempotent), and a link
 * the payload omits stays exactly where it is. Each link is validated against
 * the post-merge state using the same helpers/wording as `--set-parent`:
 * self-link, dangling target and cycle are rejected.
 *
 * `links: []` is REFUSED (E_USAGE) rather than read as "clear" — under merge an
 * empty array names no links, and silently doing nothing would hide a client
 * that still assumes replace semantics. Clearing is asked for by name with
 * `clearLinks: true`, which applies BEFORE the merge.
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

  it("accepts an empty array at the schema level (updateTask refuses it)", () => {
    // The schema still parses `[]`; the E_USAGE refusal is a handler-side
    // decision so the message can point at `clearLinks`. See the
    // "refuses links: []" case in the `updateTask links` block.
    const parsed = UpdateTaskInput.parse({ id: "abc", links: [] });
    expect(parsed.links).toEqual([]);
  });

  it("accepts an optional clearLinks boolean", () => {
    expect(UpdateTaskInput.parse({ id: "abc" }).clearLinks).toBeUndefined();
    expect(
      UpdateTaskInput.parse({ id: "abc", clearLinks: true }).clearLinks,
    ).toBe(true);
    expect(
      UpdateTaskInput.parse({ id: "abc", clearLinks: false }).clearLinks,
    ).toBe(false);
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

  it("merges into the existing set (a partial payload keeps the links it omits)", async () => {
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

    // MERGE, not replace: `other` was not named and therefore survives.
    expect(res.ok).toBe(true);
    expect(stored(task.id)?.links).toEqual([
      { taskId: parent.id, type: "parent" },
      { taskId: other.id, type: "relates" },
    ]);
  });

  it("merges a new link onto an existing set without reordering it", async () => {
    const parent = await seed("Parent");
    const extra = await seed("Extra");
    const task = await seed("Task");

    await updateTask(ctx(), {
      id: task.id,
      links: [{ taskId: parent.id, type: "parent" }],
    });
    const res = await updateTask(ctx(), {
      id: task.id,
      links: [{ taskId: extra.id, type: "relates" }],
    });

    expect(res.ok).toBe(true);
    expect(stored(task.id)?.links).toEqual([
      { taskId: parent.id, type: "parent" },
      { taskId: extra.id, type: "relates" },
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

  it("treats a duplicate link within the payload as a no-op, not a refusal", async () => {
    const a = await seed("A");
    const b = await seed("B");

    const res = await updateTask(ctx(), {
      id: a.id,
      links: [
        { taskId: b.id, type: "relates" },
        { taskId: b.id, type: "relates" },
      ],
    });

    // Under merge a pair already present is idempotent — it must not trip the
    // duplicate refusal that `validateLinkAddition` applies elsewhere.
    expect(res.ok).toBe(true);
    expect(stored(a.id)?.links).toEqual([{ taskId: b.id, type: "relates" }]);
  });

  it("is idempotent when a link already on the task is sent again", async () => {
    const a = await seed("A");
    const b = await seed("B");

    const first = await updateTask(ctx(), {
      id: a.id,
      links: [{ taskId: b.id, type: "relates" }],
    });
    const res = await updateTask(ctx(), {
      id: a.id,
      links: [{ taskId: b.id, type: "relates" }],
    });

    expect(first.ok).toBe(true);
    expect(res.ok).toBe(true);
    expect(stored(a.id)?.links).toEqual([{ taskId: b.id, type: "relates" }]);
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

  it("refuses links: [] with E_USAGE and leaves the links untouched", async () => {
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

    // Refused rather than honoured: an empty array under merge names no links,
    // and doing nothing quietly would hide a client that still assumes replace
    // semantics. The message must name the field that DOES clear.
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_USAGE");
    expect(res.error?.message).toContain("refused");
    expect(res.error?.suggestion).toContain("clearLinks");
    expect(stored(task.id)?.links).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });

  it("clears every link with clearLinks: true", async () => {
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
    expect(stored(task.id)?.links).toHaveLength(2);

    const res = await updateTask(ctx(), { id: task.id, clearLinks: true });

    expect(res.ok).toBe(true);
    expect(stored(task.id)?.links).toBeUndefined();
  });

  it("treats clearLinks: false as a no-op", async () => {
    const parent = await seed("Parent");
    const task = await seed("Task");
    await updateTask(ctx(), {
      id: task.id,
      links: [{ taskId: parent.id, type: "parent" }],
    });

    // Only `true` is an instruction — a client that always sends the flag
    // cannot wipe links by sending `false`.
    const res = await updateTask(ctx(), { id: task.id, clearLinks: false });

    expect(res.ok).toBe(true);
    expect(stored(task.id)?.links).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });

  it("applies clearLinks before the merge, so clear-then-add works in one call", async () => {
    const parent = await seed("Parent");
    const other = await seed("Other");
    const task = await seed("Task");
    await updateTask(ctx(), {
      id: task.id,
      links: [{ taskId: parent.id, type: "parent" }],
    });

    // `parent` is dropped by the clear, then re-added by the merge in the same
    // call — only `other` survives as a net addition.
    const res = await updateTask(ctx(), {
      id: task.id,
      clearLinks: true,
      links: [
        { taskId: parent.id, type: "parent" },
        { taskId: other.id, type: "relates" },
      ],
    });

    expect(res.ok).toBe(true);
    expect(stored(task.id)?.links).toEqual([
      { taskId: parent.id, type: "parent" },
      { taskId: other.id, type: "relates" },
    ]);
  });
});
