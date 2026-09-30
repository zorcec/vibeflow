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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { execFileSync } from "node:child_process";
import { manifest, type ToolManifest } from "../../../src/mcp/manifest.js";
import {
  updateTask,
  getTask,
  createTask,
  claimNextTask,
  addComment,
  verifyTaskOp,
  type OperationContext,
  TASK_NOT_FOUND_SUGGESTION,
} from "../../../src/core/operations.js";
import type { Task } from "../../../src/core/types.js";

/**
 * The verify engine shells out to Playwright. Mocked here so a dry run that
 * failed to short-circuit is caught as a recorded call instead of a browser
 * launch inside the unit suite. Only verifyTaskOp imports this module.
 */
const verifyEngine = vi.hoisted(() => ({
  verifyTask: vi.fn(async () => ({ ok: true })),
  addVerifySystemComment: vi.fn(async () => undefined),
}));
vi.mock("../../../src/commands/verify.js", () => verifyEngine);

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

/**
 * Call a tool THROUGH createMcpServer, so the assertion sees the wire payload
 * (`formatResult`) and not just the OperationResult. `_registeredTools` is the
 * SDK's private registry — the same cast tools.test.ts:472 uses; it breaks
 * loudly on an SDK upgrade rather than silently skipping these tests.
 */
async function callThroughServer(
  tool: string,
  input: unknown,
): Promise<Record<string, unknown>> {
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
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
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
    verify_task: (t) => ({
      id: t.id,
      url: "http://127.0.0.1:1/never-loaded",
      dryRun: true,
    }),
    // Preview only: reports the URLs it WOULD serve and binds nothing, so the
    // store-snapshot assertion below holds trivially — which is the point.
    start_kanban: () => ({ dryRun: true }),
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

  it("every MUTATING tool declares a dryRun input", () => {
    // The enumeration assertion above is NARROWER than it looks: it is driven
    // by `"dryRun" in t.input`, so a mutating tool that simply never declared
    // one is filtered out of `advertised` and passes unnoticed — the likelier
    // omission. This assertion is driven by the manifest's OWN classification
    // instead, which is what
    // intentionallyNotExposed["tasks --dry-run"] asserts out loud: "every
    // mutating tool exposes a `dryRun` input instead". A mutating tool with no
    // preview fails the build here.
    const mutating = manifest.filter((t) => !t.annotations.readOnlyHint);
    expect(mutating.length).toBeGreaterThan(0);
    expect(
      mutating
        .filter((t) => !("dryRun" in t.input))
        .map((t) => t.name),
    ).toEqual([]);
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

// ── 1b. verify_task's preview never reaches the browser ───────────────────

describe("verify_task dryRun", () => {
  it("the manifest advertises dryRun and the coverage probe above picks it up", () => {
    const tool = manifest.find((t) => t.name === "verify_task")!;
    expect(Object.keys(tool.input)).toContain("dryRun");
    expect(tool.category).toBe("task-mutate");
  });

  it("dryRun:true returns a preview, writes nothing and does not launch the verify engine", async () => {
    const seeded = createTestTask({ id: "task-1", status: "in-progress" });
    const before = snapshotTaskStore();
    verifyEngine.verifyTask.mockClear();
    verifyEngine.addVerifySystemComment.mockClear();

    const result = await verifyTaskOp(ctx, {
      id: seeded.id,
      url: "http://127.0.0.1:1/never-loaded",
      dryRun: true,
    });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(result.steps).toEqual([
      { code: "DRY_RUN", message: "Verification would run" },
    ]);
    expect((result.data as Task).id).toBe("task-1");
    expect(verifyEngine.verifyTask).not.toHaveBeenCalled();
    expect(verifyEngine.addVerifySystemComment).not.toHaveBeenCalled();
    expect(snapshotTaskStore()).toEqual(before);
  });

  it("dryRun:true resolves an id prefix, like the real path", async () => {
    const FULL_ID = "aabbccddeeff00112233445566778899";
    createTestTask({ id: FULL_ID });

    const result = await verifyTaskOp(ctx, { id: FULL_ID.slice(0, 8), dryRun: true });

    expect(result.ok).toBe(true);
    expect((result.data as Task).id).toBe(FULL_ID);
    expect(verifyEngine.verifyTask).not.toHaveBeenCalled();
  });

  it("the real path resolves an id prefix too — the test name above is true", async () => {
    // It was not: the preview resolved through `resolveTaskId` and the real
    // call handed the raw input to the engine, which looks the task file up
    // exactly, so the prefix this test's title promised was refused with
    // E_NOT_FOUND on the call that actually does the work.
    const FULL_ID = "aabbccddeeff00112233445566778899";
    createTestTask({ id: FULL_ID });
    verifyEngine.verifyTask.mockClear();
    verifyEngine.addVerifySystemComment.mockClear();

    const result = await verifyTaskOp(ctx, { id: FULL_ID.slice(0, 8) });

    expect(result.ok).toBe(true);
    // The engine, the comment writer and the tool all name the RESOLVED id.
    expect(verifyEngine.verifyTask).toHaveBeenCalledWith(
      ctx.projectDir,
      FULL_ID,
      expect.objectContaining({ url: undefined }),
    );
    expect(verifyEngine.addVerifySystemComment).toHaveBeenCalledWith(
      ctx.projectDir,
      FULL_ID,
      expect.anything(),
    );
  });

  it("without dryRun the engine still runs (the guard is not a stub)", async () => {
    createTestTask({ id: "task-1" });
    verifyEngine.verifyTask.mockClear();

    const result = await verifyTaskOp(ctx, { id: "task-1", dryRun: false });

    expect(result.ok).toBe(true);
    expect(verifyEngine.verifyTask).toHaveBeenCalledWith(
      ctx.projectDir,
      "task-1",
      expect.objectContaining({ url: undefined }),
    );
  });
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
    // ONE text for the code, from the shared constant: get_task used to be the
    // only tool carrying a TASK_NOT_FOUND suggestion, so the same code meant
    // two different things depending on which tool refused.
    expect(withSuggestion.error.suggestion).toBe(TASK_NOT_FOUND_SUGGESTION);
    expect(typeof withSuggestion.error.suggestion).toBe("string");
    expect(withSuggestion.error.suggestion.length).toBeGreaterThan(0);

    createTestTask({ id: "task-1", status: "todo" });
    // It used to assert the OPPOSITE here: VERIFY_REASON_REQUIRED arrived with
    // no suggestion at all. It cannot any more — the attestation contract
    // carries its own recovery text (see VerifyAttestationResolution), and a
    // refusal that says "cannot needs a reason" without saying where to put the
    // reason is exactly the unrecoverable case this lane is about.
    const withAttestationSuggestion = await callThroughServer("update_task", {
      id: "task-1",
      setVerify: "cannot",
    });
    expect(withAttestationSuggestion.error.code).toBe("VERIFY_REASON_REQUIRED");
    expect(typeof withAttestationSuggestion.error.suggestion).toBe("string");
    expect(withAttestationSuggestion.error.suggestion.length).toBeGreaterThan(0);
    // The shared-surface rule: an MCP client has no --verify-reason flag, so a
    // suggestion that named only the flag would be unusable here.
    expect(withAttestationSuggestion.error.suggestion).toContain("verifyReason");
    expect(withAttestationSuggestion.error.suggestion).toContain("--verify-reason");
  });

  it("a successful tool still returns the raw data payload", async () => {
    createTestTask({ id: "task-1", title: "Raw" });
    const parsed = await callThroughServer("get_task", { id: "task-1" });
    expect(parsed.ok).toBeUndefined();
    expect(parsed.id).toBe("task-1");
  });
});

// ── 1c. The wire payload: a preview is a preview, notices are never dropped ──

describe("success payload carries notices", () => {
  it("update_task dryRun returns a payload marked as a preview", async () => {
    createTestTask({ id: "task-1", status: "todo" });
    const before = snapshotTaskStore();

    const parsed = await callThroughServer("update_task", {
      id: "task-1",
      status: "in-progress",
      dryRun: true,
    });

    // Same task fields a real write returns …
    expect(parsed.id).toBe("task-1");
    expect(parsed.status).toBe("todo");
    // … plus the marker that makes it UNMISTAKABLY a preview. Without it the
    // payload was byte-identical to a real write's and the client could not
    // tell "nothing was written" from "it was written".
    expect(parsed.notices).toEqual([
      { code: "DRY_RUN", message: "Task would be updated" },
    ]);
    expect(snapshotTaskStore()).toEqual(before);
  });

  it("attach_file dryRun is distinguishable from the real attach", async () => {
    createTestTask({ id: "task-1" });
    const contentB64 = Buffer.from("hello").toString("base64");

    const preview = await callThroughServer("attach_file", {
      id: "task-1",
      filename: "shot.png",
      contentB64,
      dryRun: true,
    });
    // The {name,size,url} triple alone is what the real write returns …
    expect(preview.name).toBe("shot.png");
    expect(preview.size).toBe(5);
    expect(typeof preview.url).toBe("string");
    // … and only `notices` separates the two.
    expect(preview.notices).toEqual([
      { code: "DRY_RUN", message: "File would be attached" },
    ]);

    const real = await callThroughServer("attach_file", {
      id: "task-1",
      filename: "shot.png",
      contentB64,
    });
    expect(real.name).toBe("shot.png");
    expect(real.notices).toBeUndefined();
  });

  it("create_task dryRun is distinguishable from the real create", async () => {
    const preview = await callThroughServer("create_task", {
      title: "Preview only",
      dryRun: true,
    });
    expect(preview.title).toBe("Preview only");
    expect(preview.id).toBe("dry-run");
    expect(preview.notices).toEqual([
      { code: "DRY_RUN", message: "Task would be created" },
    ]);

    const real = await callThroughServer("create_task", { title: "For real" });
    expect(real.id).not.toBe("dry-run");
    expect(real.notices).toBeUndefined();
  });

  it("a plain read's payload is untouched — no notices key added", async () => {
    createTestTask({ id: "task-1", title: "Read me" });
    const parsed = await callThroughServer("get_task", { id: "task-1" });
    expect("notices" in parsed).toBe(false);
    expect(parsed.title).toBe("Read me");

    const listed = await callThroughServer("list_tasks", {});
    expect("notices" in listed).toBe(false);
  });

  it("a failed auto-commit's notices reach the client", async () => {
    // autoCommit ON in a REAL git repo with nothing staged for this task, so
    // commitTaskChanges fails the way it does in practice (a real refusal, not
    // a "not a git repository" exec error). The update itself succeeds, so ok
    // is still absent from the payload; the ONLY signal that nothing was
    // committed is `notices`, and dropping it (the previous serialisation)
    // told the client the commit had happened.
    writeSettings({ autoCommit: true, createBranch: false, requireVerifyBeforeReview: false });
    createTestTask({ id: "task-1", status: "in-progress" });
    execFileSync("git", ["init", "-q"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "mcp@example.test"], {
      cwd: testDir,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "MCP Test"], {
      cwd: testDir,
      stdio: "ignore",
    });

    const parsed = await callThroughServer("update_task", {
      id: "task-1",
      status: "review",
      comment: "what changed",
      commitMessage: "feat: thing",
    });

    expect(parsed.ok).toBeUndefined();
    expect(parsed.status).toBe("review");
    expect(Array.isArray(parsed.notices)).toBe(true);
    // The CLI emits the same code for this exact situation.
    expect((parsed.notices as Array<{ code: string }>)[0].code).toBe(
      "GIT_COMMIT_FAILED",
    );
  });

  // ── The wire contract: one field, one shape, on EVERY tool ────────────────

  /**
   * Sweep every tool that can emit a notice, through the real server, and
   * assert the two invariants a single parser depends on:
   *   1. the wire NEVER carries a `steps` key — the old name, which the CLI
   *      has never used, would send a consumer to two parsers;
   *   2. every `notices` entry is an OBJECT with string `code` and `message` —
   *      the old dry-run previews were bare strings.
   */
  it("the wire never carries `steps`, and every notice is a {code,message} object", async () => {
    createTestTask({ id: "task-1", status: "in-progress" });
    // A `todo` root as well, so `claim_next_task {dryRun:true}` has something
    // to preview and its DRY_RUN notice is actually swept. With only the
    // in-progress task on the board the claim returns a null payload and the
    // sweep would never meet that notice at all.
    createTestTask({ id: "task-2", status: "todo" });
    const b64 = Buffer.from("hello").toString("base64");
    const probes: Array<{ tool: string; input: Record<string, unknown> }> = [
      { tool: "get_task", input: { id: "task-1" } },
      { tool: "list_tasks", input: {} },
      { tool: "get_project", input: {} },
      { tool: "create_task", input: { title: "P", dryRun: true } },
      { tool: "update_task", input: { id: "task-1", status: "todo", dryRun: true } },
      { tool: "claim_next_task", input: { dryRun: true } },
      { tool: "add_comment", input: { id: "task-1", comment: "c", dryRun: true } },
      {
        tool: "attach_file",
        input: { id: "task-1", filename: "probe.png", contentB64: b64, dryRun: true },
      },
      { tool: "export_prompt", input: { id: "task-1" } },
      { tool: "push_tasks", input: { dryRun: true } },
    ];

    const offenders: string[] = [];
    let noticesSeen = 0;
    let claimNoticesSeen = 0;
    for (const p of probes) {
      const parsed = await callThroughServer(p.tool, p.input);
      // Recursive: `steps` could hide anywhere in the payload (push_tasks used
      // to nest one inside its own data object). A `null` payload (a claim on
      // an empty board) carries nothing at all, so there is nothing to find.
      const withSteps = parsed === null ? [] : findStepKeys(parsed);
      if (withSteps.length > 0) {
        offenders.push(`${p.tool}: wire carries a \`steps\` key at ${withSteps.join(", ")}`);
      }
      const notices =
        parsed === null ? undefined : (parsed as { notices?: unknown }).notices;
      if (notices === undefined) continue;
      noticesSeen++;
      if (p.tool === "claim_next_task") claimNoticesSeen++;
      if (!Array.isArray(notices)) {
        offenders.push(`${p.tool}: notices is ${typeof notices}, not an array`);
        continue;
      }
      for (const n of notices as Array<Record<string, unknown>>) {
        if (typeof n !== "object" || n === null || Array.isArray(n)) {
          offenders.push(`${p.tool}: notices entry ${JSON.stringify(n)} is not an object`);
          continue;
        }
        if (typeof n.code !== "string" || typeof n.message !== "string") {
          offenders.push(
            `${p.tool}: notices entry ${JSON.stringify(n)} lacks string code/message`,
          );
        }
      }
    }
    // The sweep is only meaningful if it actually met notices on the wire.
    expect(noticesSeen).toBeGreaterThan(0);
    // …and if it met the claim preview's own notice, not just some other
    // tool's. Pinned by name so a board change cannot quietly skip it.
    expect(claimNoticesSeen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  }, 60_000);
});

/** Every path through `value` whose key is `steps`. */
function findStepKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findStepKeys(v, `${path}[${i}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(k === "steps" ? [path] : []),
    ...findStepKeys(v, `${path}.${k}`),
  ]);
}

// ── 1d. verify_task's preview refuses an unresolvable id like the real path ─

describe("verify_task dryRun id resolution", () => {
  it("dryRun:true on a missing id returns the real path's E_NOT_FOUND", async () => {
    verifyEngine.verifyTask.mockClear();

    const preview = await callThroughServer("verify_task", {
      id: "deadbeef",
      dryRun: true,
    });

    // The real call answers E_NOT_FOUND; the preview used to answer
    // ok:true/data:null, so the two previews (update_task's refuses,
    // verify_task's did not) disagreed about the same id.
    expect(preview.ok).toBe(false);
    expect((preview.error as { code: string }).code).toBe("E_NOT_FOUND");
    expect((preview.error as { message: string }).message).toBe(
      "Task not found: deadbeef",
    );
    expect(verifyEngine.verifyTask).not.toHaveBeenCalled();

    // And update_task refuses the same id the same way.
    const updated = await callThroughServer("update_task", {
      id: "deadbeef",
      status: "in-progress",
      dryRun: true,
    });
    expect(updated.ok).toBe(false);
    expect((updated.error as { code: string }).code).toBe("TASK_NOT_FOUND");
  });
});

// ── 6. create_task parent resolution ──────────────────────────────────────

describe("create_task parent", () => {
  it("resolves a parent id PREFIX against one store scan and links the full id", async () => {
    const FULL_ID = "c0ffee00c0ffee00c0ffee00c0ffee00";
    createTestTask({ id: FULL_ID });

    const result = await createTask(ctx, {
      title: "Child",
      parent: FULL_ID.slice(0, 8),
    });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(result.data?.links).toEqual([
      { taskId: FULL_ID, type: "parent" },
    ]);
  });

  it("a dangling parent is refused, naming what the caller sent", async () => {
    createTestTask({ id: "task-1" });
    const before = snapshotTaskStore();

    const result = await createTask(ctx, {
      title: "Orphan",
      parent: "deadbeef",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CREATE_TASK_ERROR");
    expect(result.error?.message).toBe("Parent task not found: deadbeef");
    expect(snapshotTaskStore()).toEqual(before);
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

  // createBranch ON: gate 3 demands a branch ON THIS transition. The MCP path
  // never passed `branch` to checkReviewTransition, so a caller that supplied
  // one was still refused BRANCH_REQUIRED — a requested-but-ignored input, the
  // same bug class as the dryRun input that was advertised and dropped.
  it("with createBranch ON, a supplied branch reaches the gate and is stored", async () => {
    writeSettings({ autoCommit: false, createBranch: true, requireVerifyBeforeReview: true });
    createTestTask({ id: "task-1", status: "in-progress", ...annotated });

    const result = await updateTask(ctx, {
      id: "task-1",
      status: "review",
      comment: "what changed",
      setVerify: "pass",
      branch: "feat/task-1",
    });

    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const stored = JSON.parse(
      Object.values(snapshotTaskStore())[0],
    ) as Task;
    expect(stored.status).toBe("review");
    expect(stored.branchName).toBe("feat/task-1");
  });

  it("with createBranch ON and NO branch, the gate still refuses", async () => {
    writeSettings({ autoCommit: false, createBranch: true, requireVerifyBeforeReview: true });
    createTestTask({ id: "task-1", status: "in-progress", ...annotated });
    const before = snapshotTaskStore();

    const result = await updateTask(ctx, {
      id: "task-1",
      status: "review",
      comment: "what changed",
      setVerify: "pass",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("BRANCH_REQUIRED");
    expect(snapshotTaskStore()).toEqual(before);
  });
});
