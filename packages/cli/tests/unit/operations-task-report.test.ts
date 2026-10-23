/**
 * Operation-level Research report lifecycle (ticket efcd6992, P4 step 5).
 *
 * The CLI's `--report-file` translates into the update operation's internal
 * `report` input AFTER the CLI's own read-only file validation (exists,
 * .md); everything below is the operation's contract, driven in local mode
 * against throwaway stores:
 *
 * - preconditions refuse before any write: non-review status, non-Research
 *   task, non-.md name — with the CLI's exact wording, and the source file
 *   kept in every case;
 * - the gate is satisfied by the carried report (gate 5), and the upload
 *   lands before the transition write, so a gate-passed run always ends
 *   with the report attached;
 * - a failed upload refuses with the task unchanged (E_REPORT_SAVE, no
 *   partial — nothing was written) and the source kept;
 * - a failed transition AFTER a landed upload refuses partial
 *   (E_REPORT_PARTIAL: report attached, update unconfirmed) and the source
 *   kept, so the resend skips --report-file;
 * - success consumes the source (deleted) and attaches exactly once;
 * - a dry run previews without uploading or consuming.
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
import type {
  OperationContext,
  OperationResult,
} from "../../src/core/operations.js";
import type { Task } from "../../src/core/types.js";
import { LocalTaskStore } from "../../src/core/task-store.js";
import type { UpdateTaskOperationInput } from "../../src/core/operations/tasks.js";

let projectDir: string;
let ctx: OperationContext;

function seedTask(task: Record<string, unknown>): void {
  const dir = join(projectDir, ".vibeflow", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
}

function baseResearchTask(id: string): Record<string, unknown> {
  return {
    id,
    title: `Research ${id}`,
    description: "",
    status: "todo",
    type: "Research",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
  };
}

/** A real source file on disk, as the CLI would hand over after reading. */
function sourceFile(name: string, content = "# report\n"): string {
  const path = join(projectDir, name);
  writeFileSync(path, content);
  return path;
}

function reportInput(
  sourcePath: string,
  filename: string,
): UpdateTaskOperationInput["report"] {
  return {
    filename,
    bytes: new Uint8Array(readFileSync(sourcePath)),
    sourcePath,
  };
}

async function attachedNames(taskId: string): Promise<string[]> {
  const { listFiles } = await import("../../src/core/files.js");
  return listFiles(projectDir, taskId).map((f) => f.name);
}

async function storedStatus(taskId: string): Promise<string> {
  const { readTaskFile, findTaskFilePath } = await import(
    "../../src/core/tasks.js"
  );
  return readTaskFile(findTaskFilePath(projectDir, taskId)!)!.status;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "op-report-"));
  ctx = { projectDir, mode: "local" };
  // Auto-commit OFF unless a test says otherwise: the report assertions
  // are about task/file effects, and a git identity must not be required.
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(projectDir, ".vibeflow", "settings.json"),
    JSON.stringify({ autoCommit: false, autoPush: false }),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("update_task report lifecycle (local mode)", () => {
  it("refuses a report without a review transition and writes nothing", async () => {
    const { updateTask } = await import("../../src/core/operations/tasks.js");
    seedTask(baseResearchTask("r1"));
    const source = sourceFile("notes.md");
    const res = await updateTask(ctx, {
      id: "r1",
      title: "renamed",
      report: reportInput(source, "notes.md"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("E_USAGE");
    expect(res.error.message).toBe("--report-file requires --set-status review");
    // No transition, no attachment, source kept.
    expect(await storedStatus("r1")).toBe("todo");
    expect(await attachedNames("r1")).toEqual([]);
    expect(existsSync(source)).toBe(true);
  });

  it("refuses a report on a non-Research task and writes nothing", async () => {
    const { updateTask } = await import("../../src/core/operations/tasks.js");
    seedTask({
      ...baseResearchTask("t1"),
      type: "Task",
      title: "plain task",
    });
    const source = sourceFile("notes.md");
    const res = await updateTask(ctx, {
      id: "t1",
      status: "review",
      comment: "done",
      report: reportInput(source, "notes.md"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("E_USAGE");
    expect(res.error.message).toContain("only supported for Research tasks");
    expect(await storedStatus("t1")).toBe("todo");
    expect(await attachedNames("t1")).toEqual([]);
    expect(existsSync(source)).toBe(true);
  });

  it("refuses a non-.md report name and writes nothing", async () => {
    const { updateTask } = await import("../../src/core/operations/tasks.js");
    seedTask(baseResearchTask("r2"));
    const source = sourceFile("notes.txt", "plain");
    const res = await updateTask(ctx, {
      id: "r2",
      status: "review",
      comment: "done",
      report: reportInput(source, "notes.txt"),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("E_USAGE");
    expect(res.error.message).toBe("Report file must be a Markdown (.md) file");
    expect(await storedStatus("r2")).toBe("todo");
    expect(await attachedNames("r2")).toEqual([]);
    expect(existsSync(source)).toBe(true);
  });

  it("lands the report, the transition, and consumes the source on success", async () => {
    const { updateTask } = await import("../../src/core/operations/tasks.js");
    seedTask(baseResearchTask("r3"));
    const source = sourceFile("findings.md", "# findings\n");
    const res = (await updateTask(ctx, {
      id: "r3",
      status: "review",
      comment: "research done",
      report: reportInput(source, "findings.md"),
    })) as OperationResult<Task>;
    expect(res.ok).toBe(true);
    expect(await storedStatus("r3")).toBe("review");
    // Exactly one attachment with the uploaded bytes.
    expect(await attachedNames("r3")).toEqual(["findings.md"]);
    const { getFilePath } = await import("../../src/core/files.js");
    const stored = getFilePath(projectDir, "r3", "findings.md");
    expect(stored).not.toBeNull();
    expect(readFileSync(stored as string, "utf-8")).toBe("# findings\n");
    // Submission confirmed: the source is consumed.
    expect(existsSync(source)).toBe(false);
  });

  it("a failed upload refuses with the task unchanged and keeps the source", async () => {
    const { updateTask } = await import("../../src/core/operations/tasks.js");
    class FailingSaveStore extends LocalTaskStore {
      override async saveFile(): Promise<never> {
        throw new Error("disk is read-only");
      }
    }
    seedTask(baseResearchTask("r4"));
    const source = sourceFile("findings.md");
    const res = await updateTask(
      { ...ctx, store: new FailingSaveStore() },
      {
        id: "r4",
        status: "review",
        comment: "research done",
        report: reportInput(source, "findings.md"),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("E_REPORT_SAVE");
    expect(res.error.retryable).toBe(false);
    // Nothing was written: no transition, no attachment — and the source
    // survived for the resend.
    expect(await storedStatus("r4")).toBe("todo");
    expect(await attachedNames("r4")).toEqual([]);
    expect(existsSync(source)).toBe(true);
  });

  it("a failed transition after a landed upload refuses partial and keeps the source", async () => {
    const { updateTask } = await import("../../src/core/operations/tasks.js");
    class FailingWriteStore extends LocalTaskStore {
      override async updateTask(): Promise<null> {
        // Delete-between-reads race: the resolve saw the task, the write
        // missed it — after the report already landed.
        return null;
      }
    }
    seedTask(baseResearchTask("r5"));
    const source = sourceFile("findings.md");
    const res = await updateTask(
      { ...ctx, store: new FailingWriteStore() },
      {
        id: "r5",
        status: "review",
        comment: "research done",
        report: reportInput(source, "findings.md"),
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("E_REPORT_PARTIAL");
    expect(res.error.retryable).toBe(false);
    // The attachment persisted while the transition did not — and the
    // source survived so the resend skips --report-file.
    expect(await attachedNames("r5")).toEqual(["findings.md"]);
    expect(existsSync(source)).toBe(true);
  });

  it("a dry run previews without uploading or consuming", async () => {
    const { updateTask } = await import("../../src/core/operations/tasks.js");
    seedTask(baseResearchTask("r6"));
    const source = sourceFile("findings.md");
    const res = await updateTask(ctx, {
      id: "r6",
      status: "review",
      comment: "research done",
      report: reportInput(source, "findings.md"),
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.steps?.some((s) => s.code === "DRY_RUN")).toBe(true);
    // Preview only: no transition, no attachment, source kept.
    expect(await storedStatus("r6")).toBe("todo");
    expect(await attachedNames("r6")).toEqual([]);
    expect(existsSync(source)).toBe(true);
  });
});
