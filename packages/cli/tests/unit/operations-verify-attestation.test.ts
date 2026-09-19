/**
 * Agent verification verdict through the MCP/operations surface
 * (core/operations.ts) — parity with the CLI `--set-verify` / `--verify-reason`.
 *
 * `verified` is written by the AGENT, never by `vibeflow verify`: pass =
 * verified true (correct), fail = verified false (NOT correct), cannot = cleared
 * to absent (no badge) and requires a reason which is recorded in the task's
 * activity. `review-gate.ts` Gate 4 requires a verdict that lets the task
 * through (pass, or cannot with its reason) on the review transition itself, so
 * a stored flag cannot carry a task into review.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTask,
  updateTask,
  UpdateTaskInput,
  type OperationContext,
} from "../../src/core/operations.js";
import { readTaskFile, findTaskFilePath } from "../../src/core/tasks.js";
import { PROTO_DIR } from "../../src/core/types.js";

let projectDir: string;

function ctx(): OperationContext {
  return { projectDir, mode: "local", userId: "Agent Smith" };
}

/** Read the stored tri-state back from disk. */
function storedVerified(taskId: string): boolean | undefined {
  const file = findTaskFilePath(projectDir, taskId);
  expect(file).not.toBeNull();
  return readTaskFile(file!)?.verified;
}

/** The verify gate is the only gate under test — turn the rest off. */
function enableVerifyGate(): void {
  const protoDir = join(projectDir, PROTO_DIR);
  mkdirSync(protoDir, { recursive: true });
  writeFileSync(
    join(protoDir, "settings.json"),
    JSON.stringify({
      autoCommit: false,
      autoComment: false,
      autoPush: false,
      createBranch: false,
      requireVerifyBeforeReview: true,
    }),
  );
}

async function annotatedTask(title = "Annotated"): Promise<string> {
  const created = await createTask(ctx(), {
    title,
    description: "",
    url: "https://example.com",
    selector: ".submit-btn",
    cssSelector: ".submit-btn",
  });
  expect(created.ok).toBe(true);
  return created.data!.id;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "verify-attestation-ops-"));
  enableVerifyGate();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("UpdateTaskInput setVerify", () => {
  it("accepts the verdict as an optional tri-state enum", () => {
    expect(UpdateTaskInput.parse({ id: "abc" }).setVerify).toBeUndefined();
    expect(UpdateTaskInput.parse({ id: "abc", setVerify: "pass" }).setVerify).toBe(
      "pass",
    );
    expect(UpdateTaskInput.parse({ id: "abc", setVerify: "fail" }).setVerify).toBe(
      "fail",
    );
    expect(
      UpdateTaskInput.parse({
        id: "abc",
        setVerify: "cannot",
        verifyReason: "no env",
      }).setVerify,
    ).toBe("cannot");
  });
});

describe("updateTask — verdict parity with the CLI", () => {
  it("BLOCKS review of an annotated task without a verdict", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VERIFY_REQUIRED");
    expect(storedVerified(id)).toBeUndefined();
  });

  it("ALLOWS review with setVerify pass and persists verified=true", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
      setVerify: "pass",
    });

    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBe(true);
  });

  it("ALLOWS review with setVerify cannot + reason, persists absence and records the reason", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
      setVerify: "cannot",
      verifyReason: "no browser in this environment",
    });

    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBeUndefined();
    const file = findTaskFilePath(projectDir, id)!;
    const task = readTaskFile(file)!;
    const texts = (task.comments ?? []).map((c) => c.text);
    expect(
      texts.some((t) => t.includes("Cannot verify") && t.includes("no browser")),
    ).toBe(true);
  });

  it("BLOCKS review with setVerify fail even though the value is a verdict", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
      setVerify: "fail",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VERIFY_FAILED_ATTESTED");
    expect(storedVerified(id)).toBeUndefined();
  });

  it("REJECTS setVerify cannot without a reason (VERIFY_REASON_REQUIRED)", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
      setVerify: "cannot",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VERIFY_REASON_REQUIRED");
    expect(storedVerified(id)).toBeUndefined();
  });

  it("BLOCKS review when the store already says verified:false", async () => {
    const id = await annotatedTask();
    await updateTask(ctx(), { id, setVerify: "fail" });

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VERIFY_FAILED_ATTESTED");
  });

  it("resets the verdict to absent when a task is claimed", async () => {
    const id = await annotatedTask();
    await updateTask(ctx(), { id, setVerify: "pass" });
    expect(storedVerified(id)).toBe(true);

    const res = await updateTask(ctx(), { id, status: "in-progress" });

    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBeUndefined();
  });

  it("records a deliberate fail verdict passed with the claim", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "in-progress",
      setVerify: "fail",
    });

    // The explicit verdict wins over the implicit reset-on-claim, so the agent
    // can park a task it verified as WRONG.
    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBe(false);
  });

  it("treats setVerify cannot like a clear on a non-transition edit", async () => {
    const id = await annotatedTask();
    await updateTask(ctx(), { id, setVerify: "pass" });
    expect(storedVerified(id)).toBe(true);

    const res = await updateTask(ctx(), {
      id,
      title: "renamed",
      setVerify: "cannot",
      verifyReason: "no env",
    });

    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBeUndefined();
  });

  it("leaves the stored verdict alone when no verdict is passed", async () => {
    const id = await annotatedTask();
    await updateTask(ctx(), { id, setVerify: "fail" });

    const res = await updateTask(ctx(), { id, title: "renamed" });

    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBe(false);
  });
});