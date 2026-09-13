/**
 * Agent verification attestation through the MCP/operations surface
 * (core/operations.ts) — parity with the CLI `--verified` / `--verify-failed`.
 *
 * `verified` is written by the AGENT, never by `vibeflow verify`: true = the
 * agent verified the task IS implemented correctly, false = the agent verified
 * it is NOT. `review-gate.ts` Gate 4 requires the positive value on the review
 * transition itself, so a stored flag cannot carry a task into review.
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

/** The verify attestation gate is the only gate under test — turn the rest off. */
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

describe("UpdateTaskInput verified", () => {
  it("accepts the attestation as an optional boolean", () => {
    expect(UpdateTaskInput.parse({ id: "abc" }).verified).toBeUndefined();
    expect(UpdateTaskInput.parse({ id: "abc", verified: true }).verified).toBe(
      true,
    );
    expect(UpdateTaskInput.parse({ id: "abc", verified: false }).verified).toBe(
      false,
    );
  });
});

describe("updateTask — attestation parity with the CLI", () => {
  it("BLOCKS review of an annotated task without the attestation", async () => {
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

  it("ALLOWS review with verified:true and persists the attestation", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
      verified: true,
    });

    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBe(true);
  });

  it("BLOCKS review with verified:false even though the value is a verdict", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
      verified: false,
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VERIFY_FAILED_ATTESTED");
    expect(storedVerified(id)).toBeUndefined();
  });

  it("BLOCKS review when the store already says verified:false", async () => {
    const id = await annotatedTask();
    await updateTask(ctx(), { id, verified: false });

    const res = await updateTask(ctx(), {
      id,
      status: "review",
      comment: "done",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("VERIFY_FAILED_ATTESTED");
  });

  it("resets the attestation to absent when a task is claimed", async () => {
    const id = await annotatedTask();
    await updateTask(ctx(), { id, verified: true });
    expect(storedVerified(id)).toBe(true);

    const res = await updateTask(ctx(), { id, status: "in-progress" });

    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBeUndefined();
  });

  it("records a deliberate negative verdict passed with the claim", async () => {
    const id = await annotatedTask();

    const res = await updateTask(ctx(), {
      id,
      status: "in-progress",
      verified: false,
    });

    // The explicit verdict wins over the implicit reset-on-claim, so the agent
    // can park a task it verified as WRONG.
    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBe(false);
  });

  it("leaves the stored verdict alone when no attestation is passed", async () => {
    const id = await annotatedTask();
    await updateTask(ctx(), { id, verified: false });

    const res = await updateTask(ctx(), { id, title: "renamed" });

    expect(res.ok).toBe(true);
    expect(storedVerified(id)).toBe(false);
  });
});
