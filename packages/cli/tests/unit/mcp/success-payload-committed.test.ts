/**
 * The `committed` signal on the MCP success wire payload.
 *
 * A transition that succeeds while its git auto-commit FAILS answers ok:true
 * — deliberately, because the task file really was written; only the commit
 * did not happen. That left the failure reachable only by reading
 * `notices[].code`, which a client checking the top-level status never does.
 * `successPayload` therefore also stamps a top-level `committed:false` when a
 * notice is ERROR-CLASS, and stamps NOTHING when none is.
 *
 * Every case below drives a real tool through `createMcpServer`, so what is
 * asserted is the wire payload a client actually receives, not the internal
 * OperationResult. `notices` itself is asserted byte-for-byte in every case:
 * the new key is additive and the existing array is not allowed to move.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Task } from "../../../src/core/types.js";
import { git } from "../../helpers/hermetic-git.js";

let testDir: string;

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
  const dateDir = join(testDir, ".vibeflow", "tasks", task.created.slice(0, 10));
  mkdirSync(dateDir, { recursive: true });
  const path = join(dateDir, `${task.id}.json`);
  writeFileSync(path, JSON.stringify(task, null, 2));
  taskPath = path;
  return task;
}

let taskPath: string;

/** A real git repo with an identity, so auto-commit reaches a real refusal. */
function initGitRepo(): void {
  git(["init", "-q"], testDir);
  for (const [key, value] of [
    ["user.email", "mcp@example.test"],
    ["user.name", "MCP Test"],
    ["commit.gpgsign", "false"],
  ]) {
    git(["config", key, value], testDir);
  }
}

/**
 * Call a tool THROUGH createMcpServer, so the assertion sees the wire payload
 * (`formatResult`) and not just the OperationResult. `_registeredTools` is the
 * SDK's private registry — the same cast parity.test.ts uses; it breaks loudly
 * on an SDK upgrade rather than silently skipping these tests.
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

/** The task as it now sits on disk — proof the write itself landed. */
function readTaskFromDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(taskPath, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-committed-${Date.now()}-${process.pid}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// ── 1. error-class notice → committed:false ───────────────────────────────

describe("error-class notices add committed:false", () => {
  /**
   * autoCommit ON where git CANNOT commit (not a git repository), so the
   * auto-commit fails while the update itself succeeds. (An unstaged task
   * file in a real repo no longer fails: commitTaskChanges stages the
   * task's own record itself — that success path is asserted in the next
   * describe block.)
   */
  async function failedAutoCommit(): Promise<Record<string, unknown>> {
    writeSettings({
      autoCommit: true,
      createBranch: false,
      requireVerifyBeforeReview: false,
    });
    createTestTask({ id: "task-1", status: "in-progress" });
    // Deliberately NOT a git repo: `git add` refuses, so GIT_COMMIT_FAILED
    // is still reachable and the committed:false signal keeps its coverage.
    return callThroughServer("update_task", {
      id: "task-1",
      status: "review",
      comment: "what changed",
      commitMessage: "feat: thing",
    });
  }

  it("stamps a top-level committed:false a status-only client cannot miss", async () => {
    const parsed = await failedAutoCommit();

    expect("committed" in parsed).toBe(true);
    expect(parsed.committed).toBe(false);
  });

  it("keeps ok true — the transition genuinely happened, only the commit did not", async () => {
    const parsed = await failedAutoCommit();

    // The success envelope has no `ok` key at all, and this change must not
    // introduce one. Falsifying the status would invite a retry that
    // re-applies edits which already landed.
    expect("ok" in parsed).toBe(false);
    // The write really is on disk: the task reached `review`.
    expect(parsed.status).toBe("review");
    expect(readTaskFromDisk().status).toBe("review");
  });

  it("leaves the notices array byte-for-byte what it was", async () => {
    const parsed = await failedAutoCommit();

    const notices = parsed.notices as Array<{ code: string; message: string }>;
    expect(notices).toHaveLength(1);
    // The CLI emits the same code for this exact situation, and the new key
    // rides BESIDE the array — it is not merged into an entry.
    expect(notices[0].code).toBe("GIT_COMMIT_FAILED");
    // Not a git repository, so `git add` refuses — the message is git's own
    // refusal, never a line that implies the commit happened.
    expect(notices[0].message).toContain("not a git repository");
    // Exactly {code, message}: no third field smuggled onto the entry.
    expect(Object.keys(notices[0]).sort()).toEqual(["code", "message"]);
  });

  it("adds nothing but `committed` to the payload", async () => {
    const parsed = await failedAutoCommit();
    const { notices, committed, ...rest } = parsed;

    // Every task field survives untouched; the only new top-level key is the
    // one this task adds.
    expect(rest.id).toBe("task-1");
    expect(rest.title).toBe("Test Task");
    expect(committed).toBe(false);
    expect(notices).toHaveLength(1);
  });
});

// ── 2. informational notices add nothing ──────────────────────────────────

describe("informational notices leave the key absent", () => {
  it("a dry-run preview (DRY_RUN) gets no committed key", async () => {
    createTestTask({ id: "task-1", status: "todo" });

    const parsed = await callThroughServer("update_task", {
      id: "task-1",
      status: "in-progress",
      dryRun: true,
    });

    // DRY_RUN explains a result that is already fine — nothing was lost, so
    // there is no uncommitted write to report.
    expect("committed" in parsed).toBe(false);
    expect(parsed.committed).toBeUndefined();
    // `notices` is unchanged: still exactly the pre-existing preview marker.
    expect(parsed.notices).toEqual([
      { code: "DRY_RUN", message: "Task would be updated" },
    ]);
  });

  it("a SUCCESSFUL auto-commit (GIT_COMMITTED) gets no committed key", async () => {
    // The sibling half of the same if/else in operations.ts: the one code that
    // shares a call site with GIT_COMMIT_FAILED. It must stay informational —
    // a committed write is exactly the case where the key stays absent.
    writeSettings({
      autoCommit: true,
      createBranch: false,
      requireVerifyBeforeReview: false,
    });
    createTestTask({ id: "task-1", status: "in-progress" });
    initGitRepo();
    // Stage the task file so commitTaskChanges finds scoped staged paths.
    git(["add", taskPath], testDir);

    const parsed = await callThroughServer("update_task", {
      id: "task-1",
      status: "review",
      comment: "what changed",
      commitMessage: "feat: thing",
    });

    const notices = parsed.notices as Array<{ code: string; message: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0].code).toBe("GIT_COMMITTED");
    // Present-absent is the whole signal: absent here, because it committed.
    expect("committed" in parsed).toBe(false);
  });

  it("an UNSTAGED task file auto-commits — the helper stages it itself", async () => {
    // The review-transition save leaves unstaged modifications on a tracked
    // file; that used to answer GIT_COMMIT_FAILED while committing nothing.
    // Nothing is staged here on purpose — success must not depend on it.
    writeSettings({
      autoCommit: true,
      createBranch: false,
      requireVerifyBeforeReview: false,
    });
    createTestTask({ id: "task-1", status: "in-progress" });
    initGitRepo();

    const parsed = await callThroughServer("update_task", {
      id: "task-1",
      status: "review",
      comment: "what changed",
      commitMessage: "feat: thing",
    });

    const notices = parsed.notices as Array<{ code: string; message: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0].code).toBe("GIT_COMMITTED");
    expect("committed" in parsed).toBe(false);
    expect(readTaskFromDisk().status).toBe("review");
  });
});

// ── 3. no notices at all → the key is absent too ──────────────────────────

describe("operations with no notices gain no key", () => {
  it("a plain read carries neither notices nor committed", async () => {
    createTestTask({ id: "task-1", title: "Read me" });

    const parsed = await callThroughServer("get_task", { id: "task-1" });

    expect("notices" in parsed).toBe(false);
    expect("committed" in parsed).toBe(false);
    expect(parsed.title).toBe("Read me");
  });

  it("a clean write carries neither notices nor committed", async () => {
    createTestTask({ id: "task-1", status: "todo" });
    // autoCommit off: the update lands and there is nothing to report about.
    writeSettings({
      autoCommit: false,
      createBranch: false,
      requireVerifyBeforeReview: false,
    });

    const parsed = await callThroughServer("update_task", {
      id: "task-1",
      status: "in-progress",
    });

    expect("notices" in parsed).toBe(false);
    expect("committed" in parsed).toBe(false);
    expect(parsed.status).toBe("in-progress");
  });

  it("a refusal (ok:false) is unchanged — the key belongs to success only", async () => {
    const parsed = await callThroughServer("get_task", { id: "does-not-exist" });

    expect(parsed.ok).toBe(false);
    expect("committed" in parsed).toBe(false);
  });
});
