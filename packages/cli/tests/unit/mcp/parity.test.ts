/**
 * CLI ⇄ MCP parity regressions.
 *
 * Every case here is a defect that was LIVE over `vibeflow mcp` while the CLI
 * already refused it. The operations layer is shared by both surfaces
 * (enforced by gate G4 in drift.test.ts), so a guard that exists only in
 * src/index.ts is invisible to the MCP tools. These tests drive the manifest's
 * own `run:` with the same context mcp/server.ts builds — `dryRun` absent —
 * because that missing key is what made the dry-run guards dead code.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  globSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { manifest, type ToolManifest } from "../../../src/mcp/manifest.js";
import { updateTask, getTask, claimNextTask, addComment, type OperationContext } from "../../../src/core/operations.js";
import type { Task } from "../../../src/core/types.js";

let testDir: string;
// No `dryRun` key: mcp/server.ts builds exactly this context, and the defect
// under test is that the operations used to read only `ctx.dryRun`.
let ctx: OperationContext;

/** Local project settings — overrides the developer's global settings.json. */
function writeSettings(settings: Record<string, unknown>): void {
  const dir = join(testDir, ".vibeflow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(settings, null, 2),
  );
}

function createTestTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: "task-1",
    title: "Test Task",
    description: "A test task",
    status: "todo",
    selector: "/",
    created: new Date().toISOString(),
    comments: [],
    files: [],
    ...overrides,
  };
  const dateDir = join(
    testDir,
    ".vibeflow",
    "tasks",
    task.created.slice(0, 10),
  );
  mkdirSync(dateDir, { recursive: true });
  writeFileSync(
    join(dateDir, `${task.id}.json`),
    JSON.stringify(task, null, 2),
  );
  return task;
}

/** Raw bytes of every file under .vibeflow/tasks, keyed by relative path. */
function snapshotTaskStore(): Record<string, string> {
  const tasksDir = join(testDir, ".vibeflow", "tasks");
  if (!existsSync(tasksDir)) return {};
  const out: Record<string, string> = {};
  for (const file of globSync(join(tasksDir, "**", "*")).sort()) {
    if (!statSync(file).isFile()) continue;
    out[file.slice(tasksDir.length)] = readFileSync(file, "utf-8");
  }
  return out;
}

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-parity-${Date.now()}-${process.pid}`);
  mkdirSync(testDir, { recursive: true });
  ctx = { projectDir: testDir, mode: "local" };
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// ── 1. dryRun is honoured by every tool that advertises it ────────────────

describe("dryRun parity", () => {
  /** A plausible, valid input per dryRun-advertising tool. */
  const dryRunInputs: Record<string, (t: Task) => unknown> = {
    create_task: () => ({ title: "Dry Run Task", dryRun: true }),
    update_task: (t) => ({ id: t.id, status: "in-progress", dryRun: true }),
    claim_next_task: () => ({ dryRun: true }),
    add_comment: (t) => ({ id: t.id, comment: "dry run", dryRun: true }),
    attach_file: (t) => ({
      id: t.id,
      filename: "dry-run.md",
      contentB64: Buffer.from("hello").toString("base64"),
      dryRun: true,
    }),
    push_tasks: () => ({ dryRun: true, keepLocalFiles: true }),
  };

  const advertised = manifest.filter((tool) => "dryRun" in tool.input);

  it("every tool advertising dryRun is covered by this suite", () => {
    // Systemic guard: a NEW mutating tool that advertises `dryRun` must be
    // given a probe here, or this fails and forces one. Without it the loop
    // below would silently cover fewer tools over time.
    expect(advertised.map((t) => t.name).sort()).toEqual(
      Object.keys(dryRunInputs).sort(),
    );
  });

  it.each(advertised.map((t) => [t.name, t] as const))(
    "%s — dryRun:true leaves the task store byte-identical",
    async (_name, tool: ToolManifest) => {
      const seeded = createTestTask({ id: "task-1", status: "todo" });
      const before = snapshotTaskStore();
      expect(Object.keys(before).length).toBeGreaterThan(0);

      const result = await tool.run(ctx, dryRunInputs[tool.name](seeded));

      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(snapshotTaskStore()).toEqual(before);
    },
  );
});

// ── 2. Attestation parity (the CLI's refusal codes) ───────────────────────

describe("attestation parity", () => {
  it('setVerify:"cannot" with no verifyReason → VERIFY_REASON_REQUIRED, nothing written', async () => {
    createTestTask({ id: "task-1", status: "todo" });
    const before = snapshotTaskStore();

    const result = await updateTask(ctx, { id: "task-1", setVerify: "cannot" });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VERIFY_REASON_REQUIRED");
    expect(snapshotTaskStore()).toEqual(before);
  });

  it("verifyReason with no verdict → E_USAGE, nothing written", async () => {
    createTestTask({ id: "task-1", status: "todo" });
    const before = snapshotTaskStore();

    const result = await updateTask(ctx, {
      id: "task-1",
      title: "Renamed anyway",
      verifyReason: "because",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("E_USAGE");
    expect(snapshotTaskStore()).toEqual(before);
  });

  it('setVerify:"cannot" WITH a reason is still accepted and clears the verdict', async () => {
    createTestTask({ id: "task-1", status: "todo", verified: true });

    const result = await updateTask(ctx, {
      id: "task-1",
      setVerify: "cannot",
      verifyReason: "no environment to verify in",
    });

    expect(result.ok).toBe(true);
    const stored = JSON.parse(
      Object.values(snapshotTaskStore())[0],
    ) as Task;
    expect(stored.verified).toBeUndefined();
    expect(stored.comments?.some((c) => c.text.includes("Cannot verify"))).toBe(
      true,
    );
  });
});

// ── 3. Partial-id resolution parity ───────────────────────────────────────

describe("partial-id resolution parity", () => {
  const FULL_ID = "ffb1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c";
  const PREFIX = FULL_ID.slice(0, 8);

  it("get_task resolves an 8-char prefix to the full task", async () => {
    createTestTask({ id: FULL_ID, title: "Long Id Task" });

    const result = await getTask(ctx, { id: PREFIX });

    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe(FULL_ID);
    expect(result.data?.title).toBe("Long Id Task");
  });

  it("update_task resolves an 8-char prefix and writes to the full task", async () => {
    createTestTask({ id: FULL_ID, status: "todo" });

    const result = await updateTask(ctx, {
      id: PREFIX,
      title: "Renamed via prefix",
    });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(result.data?.id).toBe(FULL_ID);
    // The write landed on the real file, not on a file named after the prefix.
    const paths = Object.keys(snapshotTaskStore()).filter((p) =>
      p.endsWith(".json"),
    );
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith(`/${FULL_ID}.json`)).toBe(true);
    const stored = JSON.parse(
      snapshotTaskStore()[paths[0]],
    ) as Task;
    expect(stored.title).toBe("Renamed via prefix");
  });

  it("a prefix matching nothing is still TASK_NOT_FOUND on both tools", async () => {
    createTestTask({ id: FULL_ID });

    const got = await getTask(ctx, { id: "zzzzzzzz" });
    expect(got.ok).toBe(false);
    expect(got.error?.code).toBe("TASK_NOT_FOUND");

    const updated = await updateTask(ctx, { id: "zzzzzzzz", title: "nope" });
    expect(updated.ok).toBe(false);
    expect(updated.error?.code).toBe("TASK_NOT_FOUND");
  });

  it("the error names the full id when a prefix does not resolve", async () => {
    createTestTask({ id: FULL_ID });

    // The input is returned unchanged when nothing matches, so the message
    // quotes what the caller actually sent.
    const result = await getTask(ctx, { id: "zzzzzzzz" });
    expect(result.error?.message).toContain("zzzzzzzz");
  });
});

// ── 4. Error envelope matches the CLI's --json contract ───────────────────

describe("MCP error envelope", () => {
  async function callThroughServer(tool: string, input: unknown) {
    const { createMcpServer } = await import("../../../src/mcp/server.js");
    const registered = (
      createMcpServer(testDir, "local") as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              input: unknown,
            ) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }
        >;
      }
    )._registeredTools;
    const result = await registered[tool].handler(input);
    return JSON.parse(result.content[0].text);
  }

  it("a failing tool returns ok:false with a nested error object", async () => {
    const parsed = await callThroughServer("get_task", { id: "no-such-task" });

    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("object");
    expect(parsed.error.code).toBe("TASK_NOT_FOUND");
    expect(typeof parsed.error.message).toBe("string");
    expect(parsed.error.retryable).toBe(false);
  });

  it("suggestion is included when the operation set one, omitted otherwise", async () => {
    const withSuggestion = await callThroughServer("get_task", {
      id: "no-such-task",
    });
    expect(withSuggestion.error.suggestion).toBe(
      "Check the task ID and try again",
    );

    createTestTask({ id: "task-1", status: "todo" });
    const withoutSuggestion = await callThroughServer("update_task", {
      id: "task-1",
      setVerify: "cannot",
    });
    expect(withoutSuggestion.error.code).toBe("VERIFY_REASON_REQUIRED");
    expect("suggestion" in withoutSuggestion.error).toBe(false);
  });

  it("a successful tool still returns the raw data payload", async () => {
    createTestTask({ id: "task-1", title: "Raw" });
    const parsed = await callThroughServer("get_task", { id: "task-1" });
    expect(parsed.ok).toBeUndefined();
    expect(parsed.id).toBe("task-1");
  });
});

// ── 6. add_comment names its body `comment`, like the CLI flag ────────────

describe("add_comment input naming", () => {
  it("the manifest exposes `comment`, not `text`", () => {
    const tool = manifest.find((t) => t.name === "add_comment")!;
    expect(Object.keys(tool.input).sort()).toEqual([
      "author",
      "comment",
      "dryRun",
      "id",
    ]);
  });

  it("the body arrives in the stored comment", async () => {
    createTestTask({ id: "task-1" });
    const result = await addComment(ctx, {
      id: "task-1",
      comment: "named like the flag",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.text).toBe("named like the flag");
  });
});

// ── 5. Review-gate regression guards (already working — lock them in) ─────

describe("review gate parity", () => {
  const annotated = {
    url: "http://localhost:3000/page",
    selector: "#submit",
  };

  it("an annotated task without a verdict cannot reach review", async () => {
    writeSettings({ autoCommit: false, createBranch: false, requireVerifyBeforeReview: true });
    createTestTask({ id: "task-1", status: "in-progress", ...annotated });
    const before = snapshotTaskStore();

    const result = await updateTask(ctx, {
      id: "task-1",
      status: "review",
      comment: "what changed",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("VERIFY_REQUIRED");
    expect(snapshotTaskStore()).toEqual(before);
  });

  it("an annotated task without a commit message cannot reach review when autoCommit is ON", async () => {
    writeSettings({ autoCommit: true, createBranch: false, requireVerifyBeforeReview: true });
    createTestTask({ id: "task-1", status: "in-progress", ...annotated });
    const before = snapshotTaskStore();

    const result = await updateTask(ctx, {
      id: "task-1",
      status: "review",
      comment: "what changed",
      setVerify: "pass",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("COMMIT_MESSAGE_REQUIRED");
    expect(snapshotTaskStore()).toEqual(before);
  });

  it("with a verdict and a commit message the transition succeeds and stores verified=true", async () => {
    writeSettings({ autoCommit: false, createBranch: false, requireVerifyBeforeReview: true });
    createTestTask({ id: "task-1", status: "in-progress", ...annotated });

    const result = await updateTask(ctx, {
      id: "task-1",
      status: "review",
      comment: "what changed",
      setVerify: "pass",
    });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const stored = JSON.parse(
      Object.values(snapshotTaskStore())[0],
    ) as Task;
    expect(stored.status).toBe("review");
    expect(stored.verified).toBe(true);
  });
});
