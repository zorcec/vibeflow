/**
 * addComment operation pins (src/core/operations/comments.ts).
 *
 * The MCP and CLI comment share this path; the success write is already
 * pinned through the MCP tools suite, so this file pins the branches that
 * suite never touches:
 *
 * - dryRun validates and reports (DRY_RUN step) without writing;
 * - a comment on a missing task is TASK_NOT_FOUND and mints no ghost file;
 * - a remote refusal (RemoteReadError) travels verbatim, never relabelled;
 * - any other write throw is ADD_COMMENT_ERROR, never a silent ok.
 *
 * Each test would fail if the branch regressed (ghost task minted, refusal
 * relabelled, dry run writing).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OperationContext } from "../../src/core/operations.js";
import { addComment } from "../../src/core/operations/comments.js";
import { localTaskStore } from "../../src/core/task-store.js";
import { RemoteReadError } from "../../src/core/remote-task-store.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "op-comment-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function seedTask(id: string): void {
  const dir = join(projectDir, ".vibeflow", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: `Task ${id}`,
      description: "",
      status: "todo",
      type: "Task",
      selector: "/",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      comments: [],
      files: [],
      tags: [],
    }),
    "utf-8",
  );
}

function localCtx(): OperationContext {
  return { projectDir, mode: "local" };
}

describe("addComment operation", () => {
  it("dryRun reports the comment and writes nothing", async () => {
    seedTask("aaa00001");
    const taskPath = join(projectDir, ".vibeflow", "tasks", "aaa00001.json");
    const before = readFileSync(taskPath, "utf-8");
    const out = await addComment(localCtx(), {
      id: "aaa00001",
      author: "agent",
      comment: "preview only",
      dryRun: true,
    });
    expect(out.ok).toBe(true);
    expect(out.data?.text).toBe("preview only");
    expect(out.steps?.[0]?.code).toBe("DRY_RUN");
    expect(readFileSync(taskPath, "utf-8")).toBe(before);
  });

  it("a comment on a missing task is TASK_NOT_FOUND and mints no file", async () => {
    const out = await addComment(localCtx(), {
      id: "zzz99999",
      author: "agent",
      comment: "ghost?",
    });
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("TASK_NOT_FOUND");
    expect(
      existsSync(join(projectDir, ".vibeflow", "tasks", "zzz99999.json")),
    ).toBe(false);
  });

  it("a remote refusal travels verbatim instead of ADD_COMMENT_ERROR", async () => {
    seedTask("aaa00001");
    const remoteStore = Object.create(localTaskStore);
    remoteStore.addComment = async () => {
      throw new RemoteReadError("E_NOT_AUTHENTICATED", "token rejected", {
        suggestion: "Run 'vibeflow auth login' and retry.",
        retryable: false,
      });
    };
    const out = await addComment(
      { projectDir, mode: "local", store: remoteStore },
      { id: "aaa00001", author: "agent", comment: "hi" },
    );
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("E_NOT_AUTHENTICATED");
    expect(out.error?.message).toBe("token rejected");
  });

  it("a generic write throw is ADD_COMMENT_ERROR, never a silent ok", async () => {
    seedTask("aaa00001");
    const brokenStore = Object.create(localTaskStore);
    brokenStore.addComment = async () => {
      throw new Error("disk gone");
    };
    const out = await addComment(
      { projectDir, mode: "local", store: brokenStore },
      { id: "aaa00001", author: "agent", comment: "hi" },
    );
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe("ADD_COMMENT_ERROR");
  });
});
