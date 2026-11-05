/**
 * After-envelope site pins (ticket 431ee1c0): every operation-owned
 * `emitAfterHook` call site threads the CONFIRMED record through the new
 * `extra` parameter — the legacy payload stays byte-identical while the
 * envelope carries the full task snapshot + activityObject.
 *
 * `emitAfterHook`/`emitPreHook` are mocked (pre-gate allows): each test
 * drives the REAL operation against a temp local store (or stubbed fetch
 * for the online paths) and asserts what extras the site passed.
 * Run-intent sites (verify/push/pull) assert NO extras — task:null is
 * CORRECT there (no single task exists), pinned via the defaults in
 * `emit.test.ts`/`envelope.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { writeTar } from "@vibeflow-tools/shared/tar";
import { hashTaskRecord } from "@vibeflow-tools/shared/delta-hash";

vi.mock("../../../src/core/hooks/emit.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/core/hooks/emit.js")>();
  return {
    ...actual,
    emitAfterHook: vi.fn(async () => []),
    emitPreHook: vi.fn(async () => ({
      allowed: true,
      instructions: [],
      bypassed: false,
    })),
  };
});
vi.mock("../../../src/auth/project-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/auth/project-auth.js")>();
  return { ...actual, resolveProjectAuth: vi.fn() };
});
vi.mock("../../../src/auth/project-pointer.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/auth/project-pointer.js")>();
  return { ...actual, readProjectPointer: vi.fn() };
});
vi.mock("../../../src/auth/login.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/auth/login.js")>();
  return { ...actual, login: vi.fn(), maybeRefreshSettings: vi.fn() };
});

import { emitAfterHook } from "../../../src/core/hooks/emit.js";
import { resolveProjectAuth } from "../../../src/auth/project-auth.js";
import { readProjectPointer } from "../../../src/auth/project-pointer.js";
import { saasAuth } from "../helpers/mock-project-auth.js";
import { withOldServerProbe } from "../helpers/old-server-probe.js";
import {
  createTask,
  updateTask,
  claimNextTask,
  addComment,
  deleteTaskOperation,
  verifyTaskOp,
  type OperationContext,
} from "../../../src/core/operations.js";
import type { VerifyResult } from "../../../src/commands/verify.js";
import { push } from "../../../src/commands/push.js";
import { pull } from "../../../src/commands/pull.js";
import { ensureTaskDirs } from "../../../src/core/tasks.js";

let projectDir: string;
let ctx: OperationContext;

function afterCalls(event: string): Array<{ payload: unknown; extra: unknown }> {
  return vi
    .mocked(emitAfterHook)
    .mock.calls.filter((c) => c[2] === event)
    .map((c) => ({ payload: c[3], extra: c[5] }));
}

function rawCalls(event: string): unknown[][] {
  return vi
    .mocked(emitAfterHook)
    .mock.calls.filter((c) => c[2] === event);
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "after-sites-"));
  ensureTaskDirs(projectDir);
  ctx = { projectDir, mode: "local" };
  vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
  vi.mocked(readProjectPointer).mockReturnValue({
    apiUrl: "https://app.vibeflow.tools",
    id: "board-1",
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("after-envelope sites: task operations", () => {
  it("task.create carries the CONFIRMED record as task", async () => {
    const result = await createTask(ctx, { title: "create snapshot", status: "todo" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) throw new Error("create failed");
    const calls = afterCalls("task.create");
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({
      task: {
        id: result.data.id,
        title: "create snapshot",
        status: "todo",
      },
    });
    const extra = calls[0].extra as {
      task: { id: string; title: string; status: string };
    };
    expect(extra.task.id).toBe(result.data.id);
    expect(extra.task.title).toBe("create snapshot");
    expect(extra.task.status).toBe("todo");
  });

  it("task.update carries the post-write record + changed keys", async () => {
    const created = await createTask(ctx, { title: "update me" });
    if (!created.ok || !created.data) throw new Error("create failed");
    const id = created.data.id;
    vi.mocked(emitAfterHook).mockClear();
    const updated = await updateTask(ctx, { id, title: "updated title" });
    expect(updated.ok).toBe(true);
    const calls = afterCalls("task.update");
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ taskId: id, changed: ["title"] });
    const extra = calls[0].extra as {
      task: { id: string; title: string };
      activityObject: { changed: string[] };
    };
    expect(extra.task.id).toBe(id);
    expect(extra.task.title).toBe("updated title");
    expect(extra.activityObject).toEqual({ changed: ["title"] });
  });

  it("task.comment on the update path carries the task + written comment", async () => {
    const created = await createTask(ctx, { title: "comment me" });
    if (!created.ok || !created.data) throw new Error("create failed");
    const id = created.data.id;
    vi.mocked(emitAfterHook).mockClear();
    const updated = await updateTask(ctx, {
      id,
      title: "renamed",
      comment: "user note",
    });
    expect(updated.ok).toBe(true);
    const updateCalls = afterCalls("task.update");
    expect(updateCalls).toHaveLength(1);
    const commentCalls = afterCalls("task.comment");
    expect(commentCalls).toHaveLength(1);
    const extra = commentCalls[0].extra as {
      task: { id: string };
      activityObject: { id: string; text: string };
    };
    expect(commentCalls[0].payload).toEqual({
      taskId: id,
      commentId: extra.activityObject.id,
    });
    expect(extra.task.id).toBe(id);
    expect(extra.activityObject.text).toBe("user note");
    // The envelope task is the same confirmed post-write record as the update's.
    const updateExtra = updateCalls[0].extra as { task: { id: string } };
    expect(updateExtra.task.id).toBe(id);
  });

  it("task.claim carries the claimed record + claim filters", async () => {
    const created = await createTask(ctx, { title: "claim me", type: "Task" });
    if (!created.ok || !created.data) throw new Error("create failed");
    const id = created.data.id;
    vi.mocked(emitAfterHook).mockClear();
    const claimed = await claimNextTask(ctx, { type: "Task" });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || !claimed.data) throw new Error("claim failed");
    expect(claimed.data.id).toBe(id);
    const calls = afterCalls("task.claim");
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({
      taskId: id,
      from: "todo",
      to: claimed.data.status,
    });
    const extra = calls[0].extra as {
      task: { id: string };
      activityObject: Record<string, unknown>;
    };
    expect(extra.task.id).toBe(id);
    expect(extra.activityObject).toEqual({ type: "Task" });
  });

  it("task.comment (addComment) carries the task snapshot + written comment", async () => {
    const created = await createTask(ctx, { title: "note me" });
    if (!created.ok || !created.data) throw new Error("create failed");
    const id = created.data.id;
    vi.mocked(emitAfterHook).mockClear();
    const noted = await addComment(ctx, {
      id,
      author: "agent",
      comment: "standalone note",
    });
    expect(noted.ok).toBe(true);
    const calls = afterCalls("task.comment");
    expect(calls).toHaveLength(1);
    const extra = calls[0].extra as {
      task: { id: string; title: string };
      activityObject: { id: string; text: string };
    };
    expect(calls[0].payload).toEqual({
      taskId: id,
      commentId: extra.activityObject.id,
    });
    expect(extra.task.id).toBe(id);
    expect(extra.task.title).toBe("note me");
    expect(extra.activityObject.text).toBe("standalone note");
  });

  it("task.delete (local) carries the pre-delete row as the snapshot", async () => {
    const created = await createTask(ctx, { title: "delete me" });
    if (!created.ok || !created.data) throw new Error("create failed");
    const id = created.data.id;
    vi.mocked(emitAfterHook).mockClear();
    const deleted = await deleteTaskOperation(ctx, { id, confirmed: true });
    expect(deleted.ok).toBe(true);
    const calls = afterCalls("task.delete");
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ taskId: id, childCount: 0 });
    const extra = calls[0].extra as { task: { id: string; title: string } };
    expect(extra.task.id).toBe(id);
    expect(extra.task.title).toBe("delete me");
  });

  it("task.delete (online) carries the pre-delete row as the snapshot", async () => {
    const onlineCtx: OperationContext = { projectDir, mode: "saas" };
    const remoteId = "remote-task-1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { method?: string }) => {
        if ((init?.method ?? "GET") === "DELETE") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ deletedIds: [remoteId] }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: remoteId,
                title: "remote doomed",
                description: "",
                status: "todo",
                boardId: "board-1",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          }),
        };
      }),
    );
    const deleted = await deleteTaskOperation(onlineCtx, {
      id: remoteId,
      confirmed: true,
    });
    expect(deleted.ok).toBe(true);
    const calls = afterCalls("task.delete");
    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ taskId: remoteId, childCount: 0 });
    const extra = calls[0].extra as { task: { id: string; title: string } };
    expect(extra.task.id).toBe(remoteId);
    expect(extra.task.title).toBe("remote doomed");
  });

  it("verify passes NO extras: run intent, task:null is correct", async () => {
    const created = await createTask(ctx, { title: "verify me" });
    if (!created.ok || !created.data) throw new Error("create failed");
    const id = created.data.id;
    vi.mocked(emitAfterHook).mockClear();
    const result = await verifyTaskOp(
      ctx,
      { id },
      {
        runEngine: async () =>
          ({ verdict: "pass" }) as unknown as VerifyResult,
        writeComment: async () => {},
        resolveId: async () => ({ id }),
      },
    );
    expect(result.ok).toBe(true);
    const raw = rawCalls("verify");
    expect(raw).toHaveLength(1);
    expect(raw[0][3]).toEqual({ taskId: id, verdict: "pass" });
    // No extras argument at all — the builder defaults (task:null, no
    // activityObject, instructions:"") are the pinned shape.
    expect(raw[0].length).toBe(4);
    expect(raw[0][4]).toBeUndefined();
    expect(raw[0][5]).toBeUndefined();
  });
});

describe("after-envelope sites: sync commands", () => {
  it("push passes NO extras: set-move intent, task:null is correct", async () => {
    const dir = join(projectDir, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "push-task-1.json"),
      JSON.stringify({
        id: "push-task-1",
        title: "Push me",
        status: "todo",
        selector: "/",
        created: "2026-01-01T00:00:00.000Z",
      }),
    );
    // Legacy one-by-one loop (probe 404s): one POST per task, like the
    // "sends tasks to import API" pin in commands/push.test.ts.
    vi.stubGlobal(
      "fetch",
      withOldServerProbe(
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ id: "remote-1", externalId: "push-task-1" }),
        })),
      ),
    );
    const result = await push(projectDir, { json: true, keepLocalFiles: true });
    expect(result?.tasks).toBe(1);
    const raw = rawCalls("push");
    expect(raw).toHaveLength(1);
    expect(raw[0][3]).toEqual({
      taskCount: 1,
      chunkCount: 1,
      transport: "remote",
    });
    // No extras argument — task:null + no activityObject via defaults.
    expect(raw[0].length).toBe(4);
    expect(raw[0][4]).toBeUndefined();
    expect(raw[0][5]).toBeUndefined();
  });

  it("pull passes NO extras: archive intent, task:null is correct", async () => {
    const record = {
      id: "t1",
      title: "Task t1",
      description: "desc",
      status: "todo",
      selector: "/",
      created: "2026-01-01T00:00:00.000Z",
      comments: [],
      files: [],
    };
    const bytes = gzipSync(
      writeTar([
        {
          path: "manifest.json",
          data: Buffer.from(
            JSON.stringify({
              version: 1,
              taskCount: 1,
              fileCount: 0,
              totalFileBytes: 0,
              tasks: [{ cliId: "t1", hash: hashTaskRecord(record) }],
              files: [],
            }),
          ),
        },
        {
          path: "tasks/t1.json",
          data: Buffer.from(JSON.stringify({ clientId: "t1", record })),
        },
      ]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bytes as unknown as BodyInit, {
            status: 200,
            headers: { "content-type": "application/gzip" },
          }),
      ),
    );
    const result = await pull(projectDir, { board: "board-1" });
    expect(result.added).toBe(1);
    const raw = rawCalls("pull");
    expect(raw).toHaveLength(1);
    expect(raw[0][3]).toEqual({ written: 1, skipped: 0, mode: "apply" });
    // No extras argument — task:null + no activityObject via defaults.
    expect(raw[0].length).toBe(4);
    expect(raw[0][4]).toBeUndefined();
    expect(raw[0][5]).toBeUndefined();
  });
});
