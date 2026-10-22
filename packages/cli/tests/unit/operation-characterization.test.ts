/**
 * Operation characterization (P0, ticket 2d789b27).
 *
 * Pins TODAY's local-mode behavior for the highest-risk operations
 * (list/get/claim/edit/comment/push/pull) so that later phases change a
 * documented, asserted contract instead of silently diverging. Each test
 * drives the real operation in `core/operations.ts` against a throwaway
 * store — no mocks of the operation, the store, or ID resolution.
 *
 * Online-mode differences are NOT probed live here (no test backend in the
 * unit suite); they are pinned as data in KNOWN_DELTAS
 * (operation-surface-contract.ts) and exercised by the P9 differential lane.
 * The last test asserts that coverage exists for every sync operation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationContext } from "../../src/core/operations.js";
import { KNOWN_DELTAS } from "@vibeflow-tools/api-core";
import { OPERATION_REGISTRY } from "../../src/core/operation-registry.js";

function seedTask(projectDir: string, task: Record<string, unknown>) {
  const dir = join(projectDir, ".vibeflow", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
}

function baseTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("operation characterization (local mode)", () => {
  let projectDir: string;
  let ctx: OperationContext;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "op-char-"));
    ctx = { projectDir, mode: "local" };
  });

  it("list is root-only by default and includes matching children when filtered", async () => {
    const { listTasks } = await import("../../src/core/operations.js");
    seedTask(projectDir, baseTask("root-a"));
    seedTask(projectDir, baseTask("child-a", {
      links: [{ taskId: "root-a", type: "parent" }],
    }));

    const unfiltered = await listTasks(ctx, {});
    expect(unfiltered.ok).toBe(true);
    expect(unfiltered.data!.tasks.map((t) => t.id)).toEqual(["root-a"]);
    expect(unfiltered.data!.totalMatching).toBe(2);
    expect(unfiltered.data!.totalRoots).toBe(1);
    expect(unfiltered.data!.hiddenChildren).toBe(1);
    // Scope-aware invariant: offset + returned + remaining === scope size.
    expect(
      unfiltered.data!.offset +
        unfiltered.data!.returned +
        unfiltered.data!.remaining,
    ).toBe(unfiltered.data!.totalRoots);

    const filtered = await listTasks(ctx, { status: "todo" });
    expect(filtered.data!.tasks.map((t) => t.id).sort()).toEqual([
      "child-a",
      "root-a",
    ]);
    expect(filtered.data!.hiddenChildren).toBe(0);
  });

  it("list resolves limit 0 loudly to the default", async () => {
    const { listTasks } = await import("../../src/core/operations.js");
    const res = await listTasks(ctx, { limit: 0 });
    expect(res.ok).toBe(true);
    expect(res.data!.limit).toBe(20);
    expect(res.data!.limitNotice).toMatch(/0 is not supported/);
  });

  it("get resolves a unique prefix to the same task; unknown ids refuse", async () => {
    const { getTask } = await import("../../src/core/operations.js");
    seedTask(projectDir, baseTask("abcdef1234567890"));
    const full = await getTask(ctx, { id: "abcdef1234567890" });
    const prefix = await getTask(ctx, { id: "abcdef12" });
    expect(full.ok && prefix.ok).toBe(true);
    expect(prefix.data!.id).toBe(full.data!.id);

    const missing = await getTask(ctx, { id: "no-such-task" });
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("TASK_NOT_FOUND");
  });

  it("claim on an empty board succeeds with no payload; dryRun previews without moving", async () => {
    const { claimNextTask } = await import("../../src/core/operations.js");
    const empty = await claimNextTask(ctx, {});
    expect(empty.ok).toBe(true);
    expect(empty.data).toBeUndefined();

    seedTask(projectDir, baseTask("low", { priority: "Low" }));
    seedTask(projectDir, baseTask("high", { priority: "High" }));
    const preview = await claimNextTask(ctx, { dryRun: true });
    expect(preview.ok).toBe(true);
    expect(preview.data!.id).toBe("high");
    expect(
      preview.steps!.some((s) => s.code === "DRY_RUN"),
    ).toBe(true);

    const live = await claimNextTask(ctx, {});
    expect(live.data!.id).toBe("high");
    expect(live.data!.status).toBe("in-progress");
    // The preview named the same candidate the live call claimed.
    expect(live.data!.id).toBe(preview.data!.id);
  });

  it("claim prefers roots and never slices a child off parked work", async () => {
    const { claimNextTask } = await import("../../src/core/operations.js");
    seedTask(projectDir, baseTask("parked", { status: "done" }));
    seedTask(projectDir, baseTask("orphan", {
      links: [{ taskId: "parked", type: "parent" }],
    }));
    const res = await claimNextTask(ctx, { dryRun: true });
    // No todo root and the only todo child hangs under done work: nothing.
    expect(res.ok).toBe(true);
    expect(res.data).toBeUndefined();
  });

  it("edit to review without a comment refuses and leaves state untouched", async () => {
    const { updateTask } = await import("../../src/core/operations.js");
    seedTask(projectDir, baseTask("plain"));
    const res = await updateTask(ctx, { id: "plain", status: "review" });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("REVIEW_COMMENT_REQUIRED");

    const { readTaskFile, findTaskFilePath } = await import(
      "../../src/core/tasks.js"
    );
    expect(readTaskFile(findTaskFilePath(projectDir, "plain")!)!.status).toBe(
      "todo",
    );
  });

  it("edit persists a comment alongside a field change", async () => {
    const { updateTask } = await import("../../src/core/operations.js");
    seedTask(projectDir, baseTask("plain"));
    const res = await updateTask(ctx, {
      id: "plain",
      title: "renamed",
      comment: "progress note",
    });
    expect(res.ok).toBe(true);
    expect(res.data!.title).toBe("renamed");
    const { listComments } = await import("../../src/core/comments.js");
    expect(listComments(projectDir, "plain")).toHaveLength(1);
  });

  it("a Research task cannot carry a verdict", async () => {
    // Standalone verdict (no status change): isolates the Research rule
    // from the review-gate ordering (comment/commit gates fire first).
    const { updateTask } = await import("../../src/core/operations.js");
    seedTask(projectDir, baseTask("research", { type: "Research" }));
    const res = await updateTask(ctx, {
      id: "research",
      setVerify: "pass",
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("RESEARCH_VERIFY_NOT_ALLOWED");
  });

  it("comment on an unknown task refuses without writing a ghost", async () => {
    const { addComment } = await import("../../src/core/operations.js");
    const res = await addComment(ctx, {
      id: "ghost-target",
      comment: "hello",
    });
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe("TASK_NOT_FOUND");
    expect(readdirSync(projectDir)).not.toContain(".vibeflow");
  });

  it("attach pins today's contract: unknown id refuses, duplicates replace", async () => {
    const { attachFile } = await import("../../src/core/operations.js");
    const missing = await attachFile(ctx, {
      id: "nope",
      filename: "a.md",
      contentB64: Buffer.from("x").toString("base64"),
    });
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("TASK_NOT_FOUND");

    seedTask(projectDir, baseTask("with-file"));
    const first = await attachFile(ctx, {
      id: "with-file",
      filename: "note.md",
      contentB64: Buffer.from("one").toString("base64"),
    });
    expect(first.ok).toBe(true);
    const second = await attachFile(ctx, {
      id: "with-file",
      filename: "note.md",
      contentB64: Buffer.from("two").toString("base64"),
    });
    expect(second.ok).toBe(true);
    // MCP replacement, not CLI refusal: still exactly one file, new bytes.
    const { listFiles, getFilePath } = await import(
      "../../src/core/files.js"
    );
    const { readFileSync } = await import("node:fs");
    expect(listFiles(projectDir, "with-file")).toHaveLength(1);
    const stored = getFilePath(projectDir, "with-file", "note.md")!;
    expect(readFileSync(stored, "utf-8")).toBe("two");
  });

  it("attach dryRun previews without writing", async () => {
    const { attachFile } = await import("../../src/core/operations.js");
    seedTask(projectDir, baseTask("dry"));
    const res = await attachFile(ctx, {
      id: "dry",
      filename: "p.md",
      contentB64: Buffer.from("x").toString("base64"),
      dryRun: true,
    });
    expect(res.ok).toBe(true);
    expect(res.steps!.some((s) => s.code === "DRY_RUN")).toBe(true);
    const { listFiles } = await import("../../src/core/files.js");
    expect(listFiles(projectDir, "dry")).toHaveLength(0);
  });

  it("pull dryRun previews without touching the network or the store", async () => {
    const { pullFromBoard } = await import("../../src/core/operations.js");
    const res = await pullFromBoard(ctx, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ dryRun: true });
    expect(readdirSync(projectDir)).toEqual([]);
  });

  it("push dryRun on an empty store reports nothing-to-push without network", async () => {
    const { pushTasks } = await import("../../src/core/operations.js");
    const res = await pushTasks(ctx, { dryRun: true });
    expect(res.ok).toBe(true);
    expect(readdirSync(projectDir)).toEqual([]);
  });

  it("online divergences for sync operations are recorded as data, not prose", () => {
    // P0 pins the contract; live online probing belongs to the P9 lane.
    // This asserts the pin exists for every sync/online-touching operation.
    const ids = new Set(KNOWN_DELTAS.map((d) => d.operation));
    for (const op of ["pullFromBoard", "pushTasks"] as const) {
      expect(OPERATION_REGISTRY[op].requirement).toBe("sync");
      expect(ids.has(op)).toBe(true);
    }
    expect(ids.has("verifyTaskOp")).toBe(true);
    expect(ids.has("updateTask")).toBe(true);
    for (const d of KNOWN_DELTAS) {
      expect(d.reason.trim().length).toBeGreaterThan(20);
      expect(d.ticket).toBeTruthy();
      expect(d.expected.trim().length).toBeGreaterThan(20);
    }
  });
});
