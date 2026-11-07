/**
 * Needs-attention flag through the MCP/operations surface — parity with the
 * CLI `--set-attention` / `--clear-attention` (ticket 0752d55c).
 *
 * setAttention:true flags the task but REQUIRES `comment` on the same call
 * (the comment carries the reason); clearAttention:true clears with no
 * comment. Sending both is refused; omitting both leaves the flag untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimNextTask,
  createTask,
  updateTask,
  UpdateTaskInput,
  type OperationContext,
} from "../../src/core/operations.js";
import { ATTENTION_NOTICE_CODE } from "../../src/core/attention.js";
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
    // Reason-link fix (0752d55c): the set stores the created reason
    // comment's id on the task, so the feed tints the exact comment.
    const reason = ((stored(id).comments ?? []) as Array<{ id: string; text: string }>).find(
      (c) => c.text.includes("blocked on API response shape"),
    );
    expect(reason).toBeDefined();
    expect(stored(id).attentionReasonId).toBe(reason!.id);
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
    expect(typeof stored(id).attentionReasonId).toBe("string");

    const res = await updateTask(ctx(), { id, clearAttention: true });

    expect(res.ok).toBe(true);
    expect(stored(id).needsAttention).toBe(false);
    // Clearing the flag drops the reason link (absence = no link). The
    // normalized in-memory record keeps the key as undefined (same
    // convention as `needsAttention`/`verified`); the file bytes — the
    // durable truth — carry no link.
    expect(stored(id).attentionReasonId).toBeUndefined();
    const rawFile = readFileSync(findTaskFilePath(projectDir, id)!, "utf-8");
    expect(rawFile).not.toContain("attentionReasonId");
  });

  it("leaves the flag untouched when neither field is sent", async () => {
    const id = await plainTask();

    const res = await updateTask(ctx(), { id, title: "Renamed" });

    expect(res.ok).toBe(true);
    expect(stored(id).needsAttention).toBeUndefined();
  });

  it("keeps the reason link when a newer plain comment arrives (the bug)", async () => {
    const id = await plainTask();
    const set = await updateTask(ctx(), {
      id,
      setAttention: true,
      comment: "THE REASON",
    });
    expect(set.ok).toBe(true);
    const reasonId = stored(id).attentionReasonId as string;
    expect(typeof reasonId).toBe("string");

    const followUp = await updateTask(ctx(), {
      id,
      comment: "a newer plain comment",
    });
    expect(followUp.ok).toBe(true);
    // A plain follow-up must not move or clear the link: the feed keeps
    // tinting the true reason, never the newest comment.
    expect(stored(id).attentionReasonId).toBe(reasonId);
    const reason = ((stored(id).comments ?? []) as Array<{ id: string; text: string }>).find(
      (c) => c.id === reasonId,
    );
    expect(reason?.text).toContain("THE REASON");
  });
});

describe("claim notification — flag + reason reach the agent (owner round 2)", () => {
  async function flaggedTask(reason: string): Promise<string> {
    const id = await plainTask("Flagged work");
    const set = await updateTask(ctx(), {
      id,
      setAttention: true,
      comment: reason,
    });
    expect(set.ok).toBe(true);
    expect(stored(id).needsAttention).toBe(true);
    return id;
  }

  function attentionNotice(
    res: { steps?: Array<{ code: string; message: string }> },
  ): { code: string; message: string } | undefined {
    return (res.steps ?? []).find((s) => s.code === ATTENTION_NOTICE_CODE);
  }

  function attentionLine(res: { instructions?: string[] }): string | undefined {
    return (res.instructions ?? []).find((l) =>
      l.includes("Needs attention:"),
    );
  }

  it("updateTask to in-progress surfaces the flag + reason (payload AND instructions)", async () => {
    const id = await flaggedTask("Blocked: need the API shape");

    const res = await updateTask(ctx(), { id, status: "in-progress" });

    expect(res.ok).toBe(true);
    const notice = res.ok ? attentionNotice(res) : undefined;
    expect(notice).toBeDefined();
    expect(notice!.message).toContain("Blocked: need the API shape");
    const line = res.ok ? attentionLine(res) : undefined;
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(line).toContain("Blocked: need the API shape");
    expect(line).toContain(id);
  });

  it("updateTask stays quiet when the same call sets the flag (no echo of the agent's own reason)", async () => {
    const id = await plainTask();

    const res = await updateTask(ctx(), {
      id,
      status: "in-progress",
      setAttention: true,
      comment: "Blocked just now",
    });

    expect(res.ok).toBe(true);
    expect(res.ok ? attentionNotice(res) : undefined).toBeUndefined();
    expect(res.ok ? attentionLine(res) : undefined).toBeUndefined();
  });

  it("updateTask stays quiet on a non-claim transition of a flagged task", async () => {
    const id = await flaggedTask("Blocked: need the API shape");

    const res = await updateTask(ctx(), { id, title: "Renamed" });

    expect(res.ok).toBe(true);
    expect(res.ok ? attentionNotice(res) : undefined).toBeUndefined();
    expect(res.ok ? attentionLine(res) : undefined).toBeUndefined();
  });

  it("updateTask stays quiet when the task was never flagged", async () => {
    const id = await plainTask();

    const res = await updateTask(ctx(), { id, status: "in-progress" });

    expect(res.ok).toBe(true);
    expect(res.ok ? attentionNotice(res) : undefined).toBeUndefined();
    expect(res.ok ? attentionLine(res) : undefined).toBeUndefined();
  });

  it("claimNextTask surfaces the flag + reason on a flagged claim", async () => {
    await flaggedTask("Blocked: claim reason");

    const res = await claimNextTask(ctx(), {});

    expect(res.ok).toBe(true);
    expect(res.ok && res.data).toBeTruthy();
    const notice = res.ok ? attentionNotice(res) : undefined;
    expect(notice).toBeDefined();
    expect(notice!.message).toContain("Blocked: claim reason");
    const line = res.ok ? attentionLine(res) : undefined;
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
  });
});
