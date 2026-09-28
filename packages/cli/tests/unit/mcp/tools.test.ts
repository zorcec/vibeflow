/**
 * MCP Tools Unit Tests
 *
 * Tests each MCP tool operation with various inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, globSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  listTasks,
  getTask,
  getProject,
  type GetProjectInputType,
  createTask,
  updateTask,
  claimNextTask,
  addComment,
  attachFile,
  exportPrompt,
  verifyTaskOp,
  VERIFY_ERROR_SUGGESTION,
  type OperationContext,
} from "../../../src/core/operations.js";
import type { Task } from "../../../src/core/types.js";

// ── Test Setup ─────────────────────────────────────────────────────────────

let testDir: string;
let ctx: OperationContext;

function createTestTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: "test-task-001",
    title: "Test Task",
    description: "A test task for unit testing",
    status: "todo",
    selector: "/",
    created: new Date().toISOString(),
    comments: [],
    files: [],
    ...overrides,
  };

  const dateDir = join(testDir, ".vibeflow", "tasks", task.created.slice(0, 10));
  mkdirSync(dateDir, { recursive: true });
  writeFileSync(join(dateDir, `${task.id}.json`), JSON.stringify(task, null, 2));
  return task;
}

/** Read the persisted task JSON from disk (flat or date-subdir layout). */
function readStoredTask(id: string): Task {
  const flat = join(testDir, ".vibeflow", "tasks", `${id}.json`);
  const file = existsSync(flat)
    ? flat
    : globSync(join(testDir, ".vibeflow", "tasks", "*", `${id}.json`))[0];
  if (!file) throw new Error(`no persisted task file for ${id}`);
  return JSON.parse(readFileSync(file, "utf-8")) as Task;
}

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  ctx = { projectDir: testDir, mode: "local" };
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ── list_tasks ─────────────────────────────────────────────────────────────

describe("list_tasks", () => {
  it("returns empty list when no tasks exist", async () => {
    const result = await listTasks(ctx, { limit: 5 });
    expect(result.ok).toBe(true);
    expect(result.data?.tasks).toEqual([]);
    expect(result.data?.total).toBe(0);
  });

  it("returns all tasks", async () => {
    createTestTask({ id: "task-1", title: "Task 1" });
    createTestTask({ id: "task-2", title: "Task 2" });

    const result = await listTasks(ctx, { limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.data?.tasks).toHaveLength(2);
    expect(result.data?.total).toBe(2);
  });

  it("filters by status", async () => {
    createTestTask({ id: "task-1", status: "todo" });
    createTestTask({ id: "task-2", status: "done" });

    const result = await listTasks(ctx, { status: "todo", limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.data?.tasks).toHaveLength(1);
    expect(result.data?.tasks[0].id).toBe("task-1");
  });

  it("filters by type", async () => {
    createTestTask({ id: "task-1", type: "Bug" });
    createTestTask({ id: "task-2", type: "Feature" });

    const result = await listTasks(ctx, { type: "Bug", limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.data?.tasks).toHaveLength(1);
    expect(result.data?.tasks[0].id).toBe("task-1");
  });

  it("applies limit", async () => {
    createTestTask({ id: "task-1" });
    createTestTask({ id: "task-2" });
    createTestTask({ id: "task-3" });

    const result = await listTasks(ctx, { limit: 2 });
    expect(result.ok).toBe(true);
    expect(result.data?.tasks).toHaveLength(2);
    expect(result.data?.total).toBe(3);
  });

  it("returns specific fields", async () => {
    createTestTask({ id: "task-1", title: "Task 1", description: "Desc 1" });

    const result = await listTasks(ctx, { fields: ["id", "title"], limit: 10 });
    expect(result.ok).toBe(true);
    expect(result.data?.tasks[0]).toHaveProperty("id");
    expect(result.data?.tasks[0]).toHaveProperty("title");
    expect(result.data?.tasks[0]).not.toHaveProperty("description");
  });
});

// ── get_task ───────────────────────────────────────────────────────────────

describe("get_task", () => {
  it("returns task by ID", async () => {
    createTestTask({ id: "task-123" });

    const result = await getTask(ctx, { id: "task-123" });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe("task-123");
  });

  it("returns error for non-existent task", async () => {
    const result = await getTask(ctx, { id: "non-existent" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TASK_NOT_FOUND");
  });

  it("returns specific fields", async () => {
    createTestTask({ id: "task-1", title: "Task 1", description: "Desc 1" });

    const result = await getTask(ctx, { id: "task-1", fields: ["id", "title"] });
    expect(result.ok).toBe(true);
    expect(result.data).toHaveProperty("id");
    expect(result.data).toHaveProperty("title");
    expect(result.data).not.toHaveProperty("description");
  });
});

// ── get_project ─────────────────────────────────────────────────────────────

describe("get_project", () => {
  it("get_project returns name, absolute root, branch and mode", async () => {
    const result = await getProject(ctx, {});
    expect(result.ok).toBe(true);
    const data = result.data!;
    expect(data.root).toBe(resolve(testDir));
    expect(isAbsolute(data.root)).toBe(true);
    expect(typeof data.name).toBe("string");
    expect(data.name.length).toBeGreaterThan(0);
    expect(data.branch === null || typeof data.branch === "string").toBe(true);
    expect(data.mode).toBe("local");
  });

  it("get_project root is absolute when ctx.projectDir is relative", async () => {
    const relCtx: OperationContext = { projectDir: ".", mode: "local" };
    const result = await getProject(relCtx, {});
    expect(result.ok).toBe(true);
    expect(isAbsolute(result.data!.root)).toBe(true);
    expect(result.data!.root).toBe(resolve("."));
  });

  it("get_project ignores a caller-supplied root (no per-call root)", async () => {
    // Model 1 invariant: the tool can only *discover* the project the server
    // was started in — a root smuggled in through input must change nothing.
    const input = { root: "/evil/root" } as GetProjectInputType;
    const result = await getProject(ctx, input);
    expect(result.ok).toBe(true);
    expect(result.data!.root).toBe(resolve(testDir));
  });
});

// ── create_task ────────────────────────────────────────────────────────────

describe("create_task", () => {
  it("creates a task", async () => {
    const result = await createTask(ctx, {
      title: "New Task",
      description: "Task description",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.title).toBe("New Task");
    expect(result.data?.description).toBe("Task description");
    expect(result.data?.id).toBeTruthy();
    // status may not be set in the returned object but is stored in the file
  });

  it("respects dry_run", async () => {
    const result = await createTask(
      { ...ctx, dryRun: true },
      { title: "Dry Run Task" },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe("dry-run");
    expect(result.steps).toEqual([
      { code: "DRY_RUN", message: "Task would be created" },
    ]);
  });

  it("creates task with custom fields", async () => {
    const result = await createTask(ctx, {
      title: "Bug Report",
      type: "Bug",
      priority: "High",
      tags: ["urgent", "backend"],
    });
    expect(result.ok).toBe(true);
    expect(result.data?.type).toBe("Bug");
    expect(result.data?.priority).toBe("High");
    expect(result.data?.tags).toEqual(["urgent", "backend"]);
  });
});

// ── update_task ────────────────────────────────────────────────────────────

describe("update_task", () => {
  it("updates task status", async () => {
    createTestTask({ id: "task-1", status: "todo" });

    const result = await updateTask(ctx, {
      id: "task-1",
      status: "in-progress",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("in-progress");
  });

  it("updates task title", async () => {
    createTestTask({ id: "task-1", title: "Old Title" });

    const result = await updateTask(ctx, {
      id: "task-1",
      title: "New Title",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.title).toBe("New Title");
  });

  it("returns error for non-existent task", async () => {
    const result = await updateTask(ctx, {
      id: "non-existent",
      status: "done",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TASK_NOT_FOUND");
  });

  it("respects dry_run", async () => {
    createTestTask({ id: "task-1", status: "todo" });

    const result = await updateTask(
      { ...ctx, dryRun: true },
      { id: "task-1", status: "done" },
    );
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([
      { code: "DRY_RUN", message: "Task would be updated" },
    ]);
  });

  // Tri-state parity with the CLI: setVerify "cannot" CLEARS the verdict
  // (absent), it does NOT store false — false is the claim that the task is
  // wrong, reserved for a fail verdict.
  it("setVerify cannot clears a stored verdict to absent", async () => {
    createTestTask({ id: "task-1", verified: true });

    const result = await updateTask(ctx, {
      id: "task-1",
      setVerify: "cannot",
      verifyReason: "no env",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.verified).toBeUndefined();
    // Absence must be the missing KEY, not a false value.
    expect(readStoredTask("task-1").verified).toBeUndefined();
    expect("verified" in readStoredTask("task-1")).toBe(false);
  });

  it("setVerify fail stores false and is NOT treated as a clear", async () => {
    createTestTask({ id: "task-1", verified: true });

    const result = await updateTask(ctx, { id: "task-1", setVerify: "fail" });
    expect(result.ok).toBe(true);
    expect(result.data?.verified).toBe(false);
    expect(readStoredTask("task-1").verified).toBe(false);
    expect("verified" in readStoredTask("task-1")).toBe(true);
  });

  it("setVerify pass stores true", async () => {
    createTestTask({ id: "task-1" });

    const result = await updateTask(ctx, { id: "task-1", setVerify: "pass" });
    expect(result.ok).toBe(true);
    expect(readStoredTask("task-1").verified).toBe(true);
  });

  it("omitting setVerify leaves an existing verdict untouched", async () => {
    createTestTask({ id: "task-1", verified: true });

    await updateTask(ctx, { id: "task-1", title: "Renamed" });
    expect(readStoredTask("task-1").verified).toBe(true);
  });
});

// ── claim_next_task ────────────────────────────────────────────────────────

describe("claim_next_task", () => {
  it("claims the highest priority task", async () => {
    createTestTask({ id: "task-low", priority: "Low", status: "todo" });
    createTestTask({ id: "task-high", priority: "High", status: "todo" });

    const result = await claimNextTask(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe("task-high");
    expect(result.data?.status).toBe("in-progress");
  });

  it("returns an OK null result when no tasks are available", async () => {
    // "No work available" is not an error, and the answer is the same one a
    // valid-but-unmatched filter gets — see the filtered test below.
    const result = await claimNextTask(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("returns the same OK null result when a valid filter matches nothing", async () => {
    createTestTask({ id: "task-feature", type: "Feature", status: "todo" });
    const result = await claimNextTask(ctx, { type: "Bug" });
    expect(result.ok).toBe(true);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("dry run names exactly what the real path claims on a board where the two orders differ", async () => {
    // Seeded in an order that is NOT the claim order, with distinct authors,
    // so neither "first file listed" nor "ignores `user`" can produce the
    // right answer by accident. Correct claims (priority tier, then oldest
    // first) are deterministic regardless of how readdir orders the files.
    const at = (minsAgo: number) =>
      new Date(Date.now() - minsAgo * 60_000).toISOString();
    createTestTask({
      id: "task-1-high-bug",
      type: "Bug",
      priority: "High",
      author: "dana",
      created: at(40),
    });
    createTestTask({
      id: "task-2-medium-bug",
      type: "Bug",
      priority: "Medium",
      author: "erin",
      created: at(30),
    });
    createTestTask({
      id: "task-3-low-bug",
      type: "Bug",
      priority: "Low",
      author: "finn",
      created: at(20),
    });
    createTestTask({
      id: "task-4-feature",
      type: "Feature",
      priority: "Low",
      author: "alice",
      created: at(10),
    });
    createTestTask({
      id: "task-5-critical-bug",
      type: "Bug",
      priority: "Critical",
      author: "bob",
      created: at(50),
    });
    createTestTask({
      id: "task-6-high-bug",
      type: "Bug",
      priority: "High",
      author: "grace",
      created: at(5),
    });

    // Sorted by the same comparator the atomic path uses, the winner is the
    // Critical bug however the files happen to be listed.
    const byTypePreview = await claimNextTask(
      { ...ctx, dryRun: true },
      { type: "Bug" },
    );
    const byTypeReal = await claimNextTask(ctx, { type: "Bug" });
    expect(byTypePreview.data?.id).toBe("task-5-critical-bug");
    expect(byTypeReal.data?.id).toBe("task-5-critical-bug");

    // `user` is a documented ClaimNextTaskInput field: the dry run filters on
    // it too, so the preview names the author's own task and not some other
    // author's higher-priority todo.
    const byUserPreview = await claimNextTask(
      { ...ctx, dryRun: true },
      { user: "alice" },
    );
    const byUserReal = await claimNextTask(ctx, { user: "alice" });
    expect(byUserPreview.data?.id).toBe("task-4-feature");
    expect(byUserReal.data?.id).toBe("task-4-feature");
  });

  it("filters by type", async () => {
    createTestTask({ id: "task-bug", type: "Bug", status: "todo" });
    createTestTask({ id: "task-feature", type: "Feature", status: "todo" });

    const result = await claimNextTask(ctx, { type: "Bug" });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe("task-bug");
  });

  it("respects dry_run", async () => {
    createTestTask({ id: "task-1", status: "todo" });

    const result = await claimNextTask(
      { ...ctx, dryRun: true },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("todo"); // Not actually changed
    expect(result.steps).toEqual([
      { code: "DRY_RUN", message: "Task would be claimed" },
    ]);
  });
});

// ── add_comment ────────────────────────────────────────────────────────────

describe("add_comment", () => {
  it("adds a comment to a task", async () => {
    createTestTask({ id: "task-1" });

    const result = await addComment(ctx, {
      id: "task-1",
      comment: "This is a test comment",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.text).toBe("This is a test comment");
    // author field may be undefined in the returned comment object
    // but it's stored correctly in the task file
  });

  it("refuses a non-existent task instead of creating one", async () => {
    // It USED to succeed: core addComment writes a bare {id, comments:[…]} stub
    // for a missing task file, so add_comment on a garbage id created a ghost
    // task (title "Untitled", selector "/", status todo) and answered ok:true.
    // The board gained a task nobody created, carrying a comment on it.
    const result = await addComment(ctx, {
      id: "non-existent",
      comment: "Comment",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TASK_NOT_FOUND");
    // …and the ghost task is not on disk. The store is not self-healing, so
    // this is the assertion that matters. Globbed, not a flat path: the store
    // lays tasks out in date sub-directories.
    expect(
      globSync(join(testDir, ".vibeflow", "tasks", "**", "non-existent.json")),
    ).toEqual([]);
  });
});

// ── attach_file ────────────────────────────────────────────────────────────

describe("attach_file", () => {
  it("attaches a file to a task", async () => {
    createTestTask({ id: "task-1" });

    const content = Buffer.from("Hello, World!").toString("base64");
    const result = await attachFile(ctx, {
      id: "task-1",
      filename: "test.txt",
      contentB64: content,
    });
    expect(result.ok).toBe(true);
    expect(result.data?.name).toBe("test.txt");
  });

  it("refuses a non-existent task instead of writing a file for it", async () => {
    // Same defect shape as add_comment: validateFilename ran, then saveFile
    // wrote .vibeflow/tasks/files/<unknown-id>/<name> and answered ok:true with
    // a URL for a file belonging to a task that does not exist.
    const result = await attachFile(ctx, {
      id: "non-existent",
      filename: "shot.png",
      contentB64: Buffer.from("x").toString("base64"),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TASK_NOT_FOUND");
    expect(
      existsSync(join(testDir, ".vibeflow", "tasks", "files", "non-existent")),
    ).toBe(false);
  });
});

// ── export_prompt ──────────────────────────────────────────────────────────

describe("export_prompt", () => {
  it("exports a single task", async () => {
    createTestTask({ id: "task-1", title: "Export Me" });

    const result = await exportPrompt(ctx, { id: "task-1" });
    expect(result.ok).toBe(true);
    expect(result.data).toContain("Export Me");
  });

  it("exports all tasks when no ID specified", async () => {
    createTestTask({ id: "task-1", title: "Task 1" });
    createTestTask({ id: "task-2", title: "Task 2" });

    const result = await exportPrompt(ctx, {});
    expect(result.ok).toBe(true);
    expect(result.data).toContain("Task 1");
    expect(result.data).toContain("Task 2");
  });

  it("returns error for non-existent task", async () => {
    const result = await exportPrompt(ctx, { id: "non-existent" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TASK_NOT_FOUND");
  });
});

// ── verify_task (Fix 4.2.3 — engine error paths, no browser needed) ───────

describe("verify_task", () => {
  it("verify_task — E_NOT_FOUND for nonexistent id", async () => {
    const result = await verifyTaskOp(ctx, {
      id: "nonexistent-000",
      timeoutMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E_NOT_FOUND");
    expect(result.data).toBeUndefined();
  });

  it("verify_task — E_NO_BASELINE when the task has no baseline", async () => {
    // Task exists but carries no baseline snapshot: the engine throws at
    // step 2 (before any browser launch), and the op must surface the code.
    createTestTask({ id: "task-no-baseline" });
    const result = await verifyTaskOp(ctx, {
      id: "task-no-baseline",
      timeoutMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E_NO_BASELINE");
  });

  it("verify_task — an engine code with no text of its own still carries a suggestion", async () => {
    // E_NO_SELECTOR is thrown by the engine with NO `suggestion` of its own.
    // The passthrough used to forward that absence verbatim, so this refusal
    // reached a client as a code with nothing to act on — the one reachable
    // exception to "every tool-level refusal carries a suggestion". Reached
    // without a browser: the engine throws at step 5, before loadPlaywright().
    const id = "task-no-selector";
    createTestTask({ id, url: "https://example.com", selector: "/" });
    const filesDir = join(testDir, ".vibeflow", "tasks", "files", id);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(
      join(filesDir, "baseline-element.json"),
      JSON.stringify({ selector: ".submit" }),
    );

    const result = await verifyTaskOp(ctx, { id, timeoutMs: 60_000 });

    expect(result.ok).toBe(false);
    // The engine's code is forwarded unchanged — the fallback supplies text,
    // it does not re-code the failure.
    expect(result.error?.code).toBe("E_NO_SELECTOR");
    expect(result.error?.suggestion).toBe(VERIFY_ERROR_SUGGESTION);
  });
});

// ── push_tasks TextContent contract (D7) ──────────────────────────────

describe("push_tasks envelope", () => {
  it("push_tasks — returns a defined data object and a string TextContent", async () => {
    // Call THROUGH createMcpServer: the registered callback runs the op and
    // formatResult, so this pins the wire contract — content[0].text must be
    // a parseable JSON string, never undefined (JSON.stringify(undefined)
    // would violate the MCP TextContent contract).
    const { createMcpServer } = await import("../../../src/mcp/server.js");
    const server = createMcpServer(testDir, "local");
    const registered = (server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }
      >;
    })._registeredTools;
    const result = await registered.push_tasks.handler({
      dryRun: true,
      keepLocalFiles: true,
    });
    expect(typeof result.content[0].text).toBe("string");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });
});
