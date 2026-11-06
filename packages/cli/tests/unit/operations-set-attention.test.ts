/**
 * Needs-attention flag through the MCP/operations surface — parity with the
 * CLI `--set-attention` / `--clear-attention` (ticket 0752d55c).
 *
 * setAttention:true flags the task but REQUIRES `comment` on the same call
 * (the comment carries the reason); clearAttention:true clears with no
 * comment. Sending both is refused; omitting both leaves the flag untouched.
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

function stored(taskId: string): Record<string, unknown> {
  const file = findTaskFilePath(projectDir, taskId);
  expect(file).not.toBeNull();
  return readTaskFile(file!) as unknown as Record<string, unknown>;
}

function quietSettings(): void {
  const protoDir = join(projectDir, PROTO_DIR);
  mkdirSync(protoDir, { recursive: true });
  writeFileSync(
    join(protoDir, "settings.json"),
    JSON.stringify({
      autoCommit: false,
      autoComment: false,
      autoPush: false,
      createBranch: false,
      requireVerifyBeforeReview: false,
    }),
  );
}

async function plainTask(title = "Plain"): Promise<string> {
  const created = await createTask(ctx(), { title, description: "" });
  expect(created.ok).toBe(true);
  return (created.data as { id: string }).id;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "set-attention-ops-"));
  quietSettings();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("UpdateTaskInput setAttention / clearAttention", () => {
  it("accepts both as optional booleans, absent by default", () => {
    const parsed = UpdateTaskInput.parse({ id: "abc" });
    expect(parsed.setAttention).toBeUndefined();
    expect(parsed.clearAttention).toBeUndefined();
    expect(
      UpdateTaskInput.parse({ id: "abc", setAttention: true }).setAttention,
    ).toBe(true);
    expect(
      UpdateTaskInput.parse({ id: "abc", clearAttention: true })
        .clearAttention,
    ).toBe(true);
  });
});

describe("updateTask — needs-attention parity with the CLI", () => {
  it("SETS the flag with a comment and records the comment", async () => {
    const id = await plainTask();

    const res = await updateTask(ctx(), {
      id,
      setAttention: true,
      comment: "blocked on API response shape",
    });

    expect(res.ok).toBe(true);
    expect(stored(id).needsAttention).toBe(true);
    const texts = ((stored(id).comments ?? []) as Array<{ text: string }>).map(
      (c) => c.text,
    );
    expect(texts.some((t) => t.includes("blocked on API response shape"))).toBe(
      true,
    );
  });

  it("REFUSES setAttention:true without comment (E_USAGE) and writes nothing", async () => {
    const id = await plainTask();

    const res = await updateTask(ctx(), { id, setAttention: true });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_USAGE");
    expect(stored(id).needsAttention).toBeUndefined();
  });

  it("REFUSES setAttention + clearAttention together", async () => {
    const id = await plainTask();

    const res = await updateTask(ctx(), {
      id,
      setAttention: true,
      clearAttention: true,
      comment: "reason",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("E_USAGE");
    expect(stored(id).needsAttention).toBeUndefined();
  });

  it("CLEARS the flag with clearAttention and no comment", async () => {
    const id = await plainTask();
    const set = await updateTask(ctx(), {
      id,
      setAttention: true,
      comment: "needs eyes",
    });
    expect(set.ok).toBe(true);
    expect(stored(id).needsAttention).toBe(true);

    const res = await updateTask(ctx(), { id, clearAttention: true });

    expect(res.ok).toBe(true);
    expect(stored(id).needsAttention).toBe(false);
  });

  it("leaves the flag untouched when neither field is sent", async () => {
    const id = await plainTask();

    const res = await updateTask(ctx(), { id, title: "Renamed" });

    expect(res.ok).toBe(true);
    expect(stored(id).needsAttention).toBeUndefined();
  });
});
