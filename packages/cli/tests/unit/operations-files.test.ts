/**
 * Standalone-attach operation pins (ticket 4a5f7df6, P5 step 2).
 *
 * `attachStandalone` is the ONE implementation both surfaces route through;
 * the inputs below are the surface policies made explicit:
 *
 * - CLI (`localPath` + `refuse`): the same (task, name) pair is never
 *   uploaded twice — a duplicate is E_FILE_EXISTS and nothing is written.
 * - MCP (`bytes` + `replace`): a repeated name overwrites in place, one ref
 *   per name (the replace-in-place the characterization suite pins).
 * - missing/ambiguous targets write nothing; `--move` preview and `--move`
 *   failure retain the source; an unlink failure after a confirmed attach is
 *   MOVE_CLEANUP_FAILED on a successful attach (the bytes landed — retrying
 *   the attach would be wrong), never a whole-operation failure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationContext } from "../../src/core/operations.js";
import { attachStandalone } from "../../src/core/operations/files.js";

let projectDir: string;
let ctx: OperationContext;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "p5-files-"));
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

function baseTask(id: string): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
  };
}

function filesOnDisk(taskId: string): string[] {
  const dir = join(projectDir, ".vibeflow", "tasks", "files", taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

describe("attachStandalone (shared attach implementation)", () => {
  it("CLI policy: localPath + refuse uploads once, then refuses the same pair", async () => {
    seedTask(baseTask("t1"));
    const src = join(projectDir, "plan.md");
    writeFileSync(src, "v1");
    const first = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "localPath", path: "plan.md", cwd: projectDir },
      onExisting: "refuse",
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data?.taskId).toBe("t1");
      expect(first.data?.replaced).toBeUndefined();
    }
    expect(readFileSync(join(projectDir, ".vibeflow", "tasks", "files", "t1", "plan.md"), "utf-8")).toBe("v1");

    writeFileSync(src, "v2");
    const dup = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "localPath", path: "plan.md", cwd: projectDir },
      onExisting: "refuse",
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.code).toBe("E_FILE_EXISTS");
      expect(dup.error.message).toContain("plan.md");
    }
    // The refusal wrote nothing: the first bytes stand.
    expect(readFileSync(join(projectDir, ".vibeflow", "tasks", "files", "t1", "plan.md"), "utf-8")).toBe("v1");
  });

  it("MCP policy: bytes + replace overwrites the same name in place", async () => {
    seedTask(baseTask("t1"));
    const first = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "bytes", filename: "r.md", content: Buffer.from("v1") },
      onExisting: "replace",
    });
    expect(first.ok).toBe(true);
    const second = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "bytes", filename: "r.md", content: Buffer.from("v2") },
      onExisting: "replace",
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data?.replaced).toBe(true);
    expect(filesOnDisk("t1")).toEqual(["r.md"]);
  });

  it("missing target writes nothing; ambiguous prefix writes nothing", async () => {
    seedTask(baseTask("abc111"));
    seedTask(baseTask("abc222"));
    const src = join(projectDir, "x.md");
    writeFileSync(src, "x");
    const missing = await attachStandalone(ctx, {
      id: "nope",
      source: { kind: "localPath", path: "x.md", cwd: projectDir },
      onExisting: "refuse",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("TASK_NOT_FOUND");
    const ambiguous = await attachStandalone(ctx, {
      id: "abc",
      source: { kind: "localPath", path: "x.md", cwd: projectDir },
      onExisting: "refuse",
    });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error.code).toBe("E_AMBIGUOUS");
    expect(filesOnDisk("abc111")).toEqual([]);
    expect(filesOnDisk("abc222")).toEqual([]);
    // The source is retained on refusal.
    expect(existsSync(src)).toBe(true);
  });

  it("localPath gates: missing path and directory refuse before any store read", async () => {
    seedTask(baseTask("t1"));
    const missing = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "localPath", path: "gone.md", cwd: projectDir },
      onExisting: "refuse",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("E_NOT_FOUND");
    const dir = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "localPath", path: ".", cwd: projectDir },
      onExisting: "refuse",
    });
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.error.code).toBe("E_USAGE");
    expect(filesOnDisk("t1")).toEqual([]);
  });

  it("dry-run previews without writing and keeps the source (even with move)", async () => {
    seedTask(baseTask("t1"));
    const src = join(projectDir, "move.md");
    writeFileSync(src, "m");
    const r = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "localPath", path: "move.md", cwd: projectDir },
      onExisting: "refuse",
      moveAfterSuccess: true,
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps).toEqual([{ code: "DRY_RUN", message: "File would be attached" }]);
      expect(r.data?.name).toBe("move.md");
    }
    expect(filesOnDisk("t1")).toEqual([]);
    expect(existsSync(src)).toBe(true);
  });

  it("move consumes the source only after a confirmed attach", async () => {
    seedTask(baseTask("t1"));
    const src = join(projectDir, "ship.md");
    writeFileSync(src, "s");
    const r = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "localPath", path: "ship.md", cwd: projectDir },
      onExisting: "refuse",
      moveAfterSuccess: true,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(src)).toBe(false);
    expect(filesOnDisk("t1")).toEqual(["ship.md"]);
  });

  it("without move the source is kept after a confirmed attach", async () => {
    seedTask(baseTask("t1"));
    const src = join(projectDir, "keep.md");
    writeFileSync(src, "k");
    const r = await attachStandalone(ctx, {
      id: "t1",
      source: { kind: "localPath", path: "keep.md", cwd: projectDir },
      onExisting: "refuse",
    });
    expect(r.ok).toBe(true);
    expect(existsSync(src)).toBe(true);
  });
});
