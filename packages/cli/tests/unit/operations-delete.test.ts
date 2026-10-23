/**
 * Delete-operation pins (ticket 4a5f7df6, P5 step 5).
 *
 * `deleteTaskOperation` is CLI-only (no MCP delete tool by design), driven
 * here in local mode against throwaway stores:
 *
 * - empty id → TASK_NOT_FOUND before any read;
 * - unique prefix resolves, ambiguous prefix is E_AMBIGUOUS naming every
 *   candidate, unknown id is TASK_NOT_FOUND — and nothing is written;
 * - unconfirmed runs refuse CONFIRM_REQUIRED (preview, non-zero) with the
 *   parent's children named in the preview;
 * - `--yes --dry-run` reports the plan (exit ok) and deletes nothing;
 * - a local parent refuses even WITH --yes (HAS_CHILDREN, no cascade);
 *   deleting the children first unblocks the parent;
 * - a confirmed leaf deletes exactly one row and reports deletedIds [id].
 *
 * The online cascade (remote DELETE, deletedIds cone, local clone cleanup)
 * is pinned by tests/e2e/tasks-delete.test.ts against the fake backend.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationContext } from "../../src/core/operations.js";
import { deleteTaskOperation } from "../../src/core/operations.js";

let projectDir: string;
let ctx: OperationContext;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "p5-delete-"));
  ctx = { projectDir, mode: "local" };
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function seedTask(task: Record<string, unknown>): void {
  const dir = join(projectDir, ".vibeflow", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
}

function baseTask(id: string, links: Array<{ taskId: string; type: string }> = []): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
    ...(links.length > 0 ? { links } : {}),
  };
}

function taskExists(id: string): boolean {
  return existsSync(join(projectDir, ".vibeflow", "tasks", `${id}.json`));
}

describe("deleteTaskOperation (local mode)", () => {
  it("refuses an empty id before reading anything", async () => {
    seedTask(baseTask("t1"));
    const r = await deleteTaskOperation(ctx, { id: "", confirmed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TASK_NOT_FOUND");
      expect(r.error.message).toContain("must not be empty");
    }
    expect(taskExists("t1")).toBe(true);
  });

  it("resolves a unique prefix; refuses unknown and ambiguous ids with nothing written", async () => {
    seedTask(baseTask("aaa111"));
    seedTask(baseTask("aaa222"));
    seedTask(baseTask("b1"));
    const unique = await deleteTaskOperation(ctx, { id: "b", confirmed: false });
    expect(unique.ok).toBe(false);
    if (!unique.ok) expect(unique.error.code).toBe("CONFIRM_REQUIRED");
    const unknown = await deleteTaskOperation(ctx, { id: "ghost", confirmed: true });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("TASK_NOT_FOUND");
    const ambiguous = await deleteTaskOperation(ctx, { id: "aaa", confirmed: true });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.error.code).toBe("E_AMBIGUOUS");
      expect(ambiguous.error.message).toContain("aaa111");
      expect(ambiguous.error.message).toContain("aaa222");
    }
    expect(taskExists("aaa111")).toBe(true);
    expect(taskExists("aaa222")).toBe(true);
    expect(taskExists("b1")).toBe(true);
  });

  it("unconfirmed delete previews with the children named and deletes nothing", async () => {
    seedTask(baseTask("parent1"));
    seedTask(baseTask("child1", [{ taskId: "parent1", type: "parent" }]));
    const r = await deleteTaskOperation(ctx, { id: "parent1", confirmed: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CONFIRM_REQUIRED");
      expect(r.error.message).toContain("parent1");
      expect(r.error.preview?.children).toEqual([{ id: "child1", title: "Task child1" }]);
    }
    expect(taskExists("parent1")).toBe(true);
    expect(taskExists("child1")).toBe(true);
  });

  it("--yes --dry-run reports the plan, exits ok, and deletes nothing", async () => {
    seedTask(baseTask("t1"));
    const r = await deleteTaskOperation(ctx, { id: "t1", confirmed: true, dryRun: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.id).toBe("t1");
      expect(r.data.deletedIds).toEqual(["t1"]);
    }
    expect(taskExists("t1")).toBe(true);
  });

  it("a local parent refuses even WITH --yes; deleting children first unblocks it", async () => {
    seedTask(baseTask("parent1"));
    seedTask(baseTask("child1", [{ taskId: "parent1", type: "parent" }]));
    const refused = await deleteTaskOperation(ctx, { id: "parent1", confirmed: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("HAS_CHILDREN");
      expect(refused.error.message).toContain("child1");
    }
    // Deepest first, then the parent.
    const dropChild = await deleteTaskOperation(ctx, { id: "child1", confirmed: true });
    expect(dropChild.ok).toBe(true);
    expect(taskExists("child1")).toBe(false);
    const dropParent = await deleteTaskOperation(ctx, { id: "parent1", confirmed: true });
    expect(dropParent.ok).toBe(true);
    if (dropParent.ok) expect(dropParent.data.deletedIds).toEqual(["parent1"]);
    expect(taskExists("parent1")).toBe(false);
  });

  it("a confirmed leaf deletes exactly one row and reports deletedIds [id]", async () => {
    seedTask(baseTask("t1"));
    seedTask(baseTask("t2"));
    const r = await deleteTaskOperation(ctx, { id: "t1", confirmed: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(false);
      expect(r.data.deletedIds).toEqual(["t1"]);
    }
    expect(taskExists("t1")).toBe(false);
    expect(taskExists("t2")).toBe(true);
  });
});
