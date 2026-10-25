/**
 * Diff-based push + per-task atomicity.
 *
 * Ground truth (mocks ONLY): `fetchOnlineTaskIds` pages the board listing;
 * `push()` pushes ONLY ids missing from that set (no-op with an honest
 * line when the diff is empty); `partitionImportInputs`/`importBatchTree`
 * skip whole tasks that cannot fit one import call (never partially
 * created, never recorded as done — the next run retries them).
 *
 * Non-vacuity: each claim names its break — applied, observed red, reverted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../../src/auth/project-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auth/project-auth.js")>();
  return { ...actual, resolveProjectAuth: vi.fn() };
});
vi.mock("../../../src/auth/project-pointer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auth/project-pointer.js")>();
  return { ...actual, readProjectPointer: vi.fn() };
});
vi.mock("../../../src/auth/login.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/auth/login.js")>();
  return { ...actual, login: vi.fn(), maybeRefreshSettings: vi.fn() };
});
vi.mock("../../../src/core/files.js", () => ({
  listFiles: vi.fn(),
  getFilesDir: vi.fn(),
}));

import { resolveProjectAuth } from "../../../src/auth/project-auth.js";
import { readProjectPointer } from "../../../src/auth/project-pointer.js";
import { saasAuth, TEST_API_URL } from "../helpers/mock-project-auth.js";
import * as filesModule from "../../../src/core/files.js";
import { push } from "../../../src/commands/push.js";
import {
  fetchOnlineTaskIds,
  partitionImportInputs,
  importBatchTree,
  type ImportTaskInput,
} from "../../../src/saas/batch-push.js";
import { withOldServerProbe } from "../helpers/old-server-probe.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "push-diff-"));
}

function createTaskFile(projectDir: string, task: Record<string, unknown>): string {
  const protoDir = join(projectDir, ".vibeflow", "tasks", "2025-01-01");
  mkdirSync(protoDir, { recursive: true });
  const filePath = join(protoDir, `${task.id}.json`);
  writeFileSync(filePath, JSON.stringify(task));
  return filePath;
}

function fileInput(name: string, size: number): ImportTaskInput["files"][number] {
  return { name, filePath: join(tmpdir(), name), size, system: false };
}

describe("fetchOnlineTaskIds (shared diff helper)", () => {
  it("follows nextCursor and collects every id-like key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [{ id: "a", cliId: "a-cli" }],
            nextCursor: "c1",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [{ externalId: "b", cloudId: "b-cloud" }],
            nextCursor: null,
          }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const ids = await fetchOnlineTaskIds("https://x.test", "tok", "board-1");
    expect([...ids].sort()).toEqual(["a", "a-cli", "b", "b-cloud"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=100");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=c1");
    // Break: read only the first page — b/b-cloud vanish from the set.
  });

  it("stops when the server echoes the cursor (bounded, no hang)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [{ id: "a" }], nextCursor: "x" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    // First call (no cursor) → next "x"; second (cursor=x) → next "x"
    // echoes → break. Exactly 2 calls, never a loop.
    const ids = await fetchOnlineTaskIds("https://x.test", "tok", "b");
    expect(ids.has("a")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-ok listing (callers decide, never silent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(fetchOnlineTaskIds("https://x.test", "tok", "b")).rejects.toThrow(
      "board listing failed: HTTP 500",
    );
  });
});

describe("partitionImportInputs (per-task atomicity gate)", () => {
  const caps = { maxTasks: 100, maxFiles: 50, maxBytes: 25 * 1024 * 1024 };

  it("passes fitting tasks through untouched", () => {
    const inputs: ImportTaskInput[] = [
      { localId: "a", record: {}, files: [fileInput("f", 100)] },
      { localId: "b", record: {}, files: [] },
    ];
    const { pushable, skipped } = partitionImportInputs(inputs, {
      ...caps,
      maxFileBytes: 5 * 1024 * 1024,
    });
    expect(pushable.map((t) => t.localId)).toEqual(["a", "b"]);
    expect(skipped).toEqual([]);
  });

  it("skips whole the task with an oversize file (exact reason)", () => {
    const inputs: ImportTaskInput[] = [
      {
        localId: "heavy",
        record: {},
        files: [fileInput("ok.txt", 10), fileInput("big.bin", 6 * 1024 * 1024)],
      },
    ];
    const { pushable, skipped } = partitionImportInputs(inputs, {
      ...caps,
      maxFileBytes: 5 * 1024 * 1024,
    });
    expect(pushable).toEqual([]);
    expect(skipped).toEqual([
      {
        localId: "heavy",
        reason:
          'file "big.bin" (6291456 bytes) exceeds the per-file cap of 5242880 bytes — task skipped whole, retryable',
      },
    ]);
    // Break: create the task anyway — the server stores it fileless
    // (partial creation) and the skip list reads empty.
  });

  it("null maxFileBytes never skips on the per-file rule", () => {
    const inputs: ImportTaskInput[] = [
      { localId: "heavy", record: {}, files: [fileInput("big.bin", 6 * 1024 * 1024)] },
    ];
    const { pushable, skipped } = partitionImportInputs(inputs, {
      ...caps,
      maxFileBytes: null,
    });
    expect(pushable.map((t) => t.localId)).toEqual(["heavy"]);
    expect(skipped).toEqual([]);
  });

  it("skips whole the task whose files exceed the per-request byte cap", () => {
    const inputs: ImportTaskInput[] = [
      { localId: "huge", record: {}, files: [fileInput("huge.bin", 26 * 1024 * 1024)] },
    ];
    const { pushable, skipped } = partitionImportInputs(inputs, {
      ...caps,
      maxFileBytes: null,
    });
    expect(pushable).toEqual([]);
    expect(skipped).toEqual([
      {
        localId: "huge",
        reason:
          "task files total 27262976 bytes exceeds the per-request cap of 26214400 bytes — task skipped whole, retryable",
      },
    ]);
  });

  it("skips whole the task whose file count cannot fit an empty chunk", () => {
    const inputs: ImportTaskInput[] = [
      {
        localId: "many",
        record: {},
        files: Array.from({ length: 51 }, (_, i) => fileInput(`f${i}`, 10)),
      },
    ];
    const { pushable, skipped } = partitionImportInputs(inputs, {
      ...caps,
      maxFileBytes: null,
    });
    expect(pushable).toEqual([]);
    expect(skipped).toEqual([
      {
        localId: "many",
        reason:
          "task has 51 file(s), exceeding the per-request cap of 50 — task skipped whole, retryable",
      },
    ]);
  });
});

describe("importBatchTree atomicity (skipped whole, retried next run)", () => {
  function okFetch() {
    return vi.fn().mockImplementation((_url: unknown, init?: { body?: unknown }) => {
      const text = String((init?.body as FormData).get("manifest"));
      const manifest = JSON.parse(text) as { tasks: Array<{ clientId: string }> };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            created: manifest.tasks.length,
            existing: 0,
            failed: 0,
            linksApplied: 0,
            linksFailed: 0,
            filesUploaded: 0,
            filesFailed: 0,
            filesSkipped: 0,
            results: manifest.tasks.map((t) => ({ clientId: t.clientId, id: `cloud-${t.clientId}` })),
          }),
      });
    });
  }

  it("oversize-file task is skipped whole: not imported, not in the idMap", async () => {
    vi.stubGlobal("fetch", okFetch());
    const result = await importBatchTree(
      "https://x.test",
      "tok",
      "b",
      [
        { localId: "ok", record: { id: "ok" }, files: [] },
        {
          localId: "heavy",
          record: { id: "heavy" },
          files: [fileInput("big.bin", 6 * 1024 * 1024)],
        },
      ],
      { maxFileBytes: 5 * 1024 * 1024, pacingDelayMs: 0 },
    );
    expect(result.imported).toBe(1);
    expect(result.idMap).toEqual({ ok: "cloud-ok" });
    expect(result.skippedTasks).toEqual([
      {
        localId: "heavy",
        reason:
          'file "big.bin" (6291456 bytes) exceeds the per-file cap of 5242880 bytes — task skipped whole, retryable',
      },
    ]);
    // Break: route the skipped task into a chunk anyway — imported reads
    // 2 and the skip list is empty (partial creation downstream).
  });

  it("skipped tasks are re-attempted on the next run (cap raised → pushed)", async () => {
    vi.stubGlobal("fetch", okFetch());
    const dir = makeTempProject();
    const inputs: ImportTaskInput[] = [
      { localId: "ok", record: { id: "ok" }, files: [] },
      {
        localId: "heavy",
        record: { id: "heavy" },
        files: [fileInput("big.bin", 20)],
      },
    ];
    const first = await importBatchTree("https://x.test", "tok", "b", inputs, {
      projectDir: dir,
      maxFileBytes: 10,
      pacingDelayMs: 0,
    });
    expect(first.imported).toBe(1);
    expect(first.skippedTasks.map((s) => s.localId)).toEqual(["heavy"]);
    expect(first.idMap["heavy"]).toBeUndefined();
    // Success clears the checkpoint — nothing records heavy as done.
    expect(existsSync(join(dir, ".vibeflow", "push-batch.checkpoint.json"))).toBe(false);
    // Next run (plan raised): heavy is attempted and created.
    const second = await importBatchTree("https://x.test", "tok", "b", inputs, {
      projectDir: dir,
      maxFileBytes: null,
      pacingDelayMs: 0,
    });
    expect(second.imported).toBe(2);
    expect(second.skippedTasks).toEqual([]);
    expect(second.idMap["heavy"]).toBe("cloud-heavy");
  });
});

describe("push — diff-based (only unsynced travel)", () => {
  beforeEach(() => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
    vi.mocked(readProjectPointer).mockReturnValue({
      apiUrl: TEST_API_URL,
      id: "ws-1",
    });
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  function legacyCreateMock() {
    return vi.fn((_url: unknown, init?: { body?: string }) => {
      const payload = JSON.parse(init?.body as string) as { id: string };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: `remote-${payload.id}` }),
      });
    });
  }

  function taskRecord(id: string): Record<string, unknown> {
    return {
      id,
      title: `Title ${id}`,
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    };
  }

  it("pushes only unsynced tasks (already-on-board ids are never POSTed)", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("synced-1"));
    createTaskFile(projectDir, taskRecord("new-1"));
    const inner = legacyCreateMock();
    vi.stubGlobal(
      "fetch",
      withOldServerProbe(inner, { listItems: [{ id: "synced-1", cliId: "synced-1" }] }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    expect(inner).toHaveBeenCalledTimes(1);
    expect(JSON.parse(inner.mock.calls[0]?.[1]?.body as string).id).toBe("new-1");
    expect(logSpy).toHaveBeenCalledWith(
      // Wording fix: one preamble line (local / on-board / to-send) replaces
      // the old two-parenthetical sentence whose counts contradicted each other.
      expect.stringContaining("Push plan: 2 local task(s), 1 already on the board, 1 to send"),
    );
    logSpy.mockRestore();
    // Break: push taskList instead of the diff — inner reads 2 calls.
  });

  it("no-op when the diff is empty: honest line, exit 0, no creates, locals kept", async () => {
    const projectDir = makeTempProject();
    const filePath = createTaskFile(projectDir, taskRecord("synced-1"));
    const inner = legacyCreateMock();
    const outer = withOldServerProbe(inner, {
      listItems: [{ id: "synced-1", cliId: "synced-1" }],
    });
    vi.stubGlobal("fetch", outer);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    const result = (await push(projectDir, {})) as unknown as {
      tasks: number;
      files: number;
    };

    expect(logSpy).toHaveBeenCalledWith(
      // Wording fix: a no-op never reads "Pushed 0" — it names what happened.
      expect.stringContaining("Nothing to push — board already has all 1 task(s)."),
    );
    expect(inner).not.toHaveBeenCalled();
    // Two read-only calls now: the diff listing AND the capability probe. The
    // probe is hoisted so a LOSSLESS server can reconcile existing tasks; on
    // this old server it answers 404, so the no-op stands and nothing is
    // created.
    expect(outer).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
    expect(result.tasks).toBe(0);
    expect(existsSync(filePath)).toBe(true);
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
    // Break: skip the diff and always probe — outer reads 2+ calls.
  });

  it("a LOSSLESS server re-sends tasks already on the board (reconciliation)", async () => {
    const projectDir = makeTempProject();
    const filePath = createTaskFile(projectDir, taskRecord("synced-1"));
    const created: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: { method?: string; body?: unknown }) => {
        const method = init?.method ?? "GET";
        if (String(url).endsWith("/api/v0/tasks/import")) {
          if (method === "GET") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  maxTasks: 100,
                  maxFiles: 50,
                  maxBytes: 25 * 1024 * 1024,
                  plan: "free",
                  lossless: true,
                  openLimit: 500,
                  openUsed: 0,
                  openRemaining: 500,
                  totalLimit: 2000,
                  totalUsed: 0,
                  totalRemaining: 2000,
                }),
            });
          }
          const manifest = JSON.parse(String((init?.body as FormData).get("manifest"))) as {
            tasks: Array<{ clientId: string }>;
          };
          created.push(...manifest.tasks.map((t) => t.clientId));
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                created: 0,
                existing: manifest.tasks.length,
                unchanged: manifest.tasks.length,
                failed: 0,
                linksApplied: 0,
                linksFailed: 0,
                filesUploaded: 0,
                filesFailed: 0,
                filesSkipped: 0,
                results: manifest.tasks.map((t) => ({
                  clientId: t.clientId,
                  id: t.clientId,
                  existing: true,
                })),
              }),
          });
        }
        if (String(url).includes("/api/v0/tasks?") && method === "GET") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ items: [{ id: "synced-1" }], nextCursor: null }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, {});

    // The task is already on the board, but only a re-send can repair the
    // comments/commits/links an older lossy import dropped.
    expect(created).toEqual(["synced-1"]);
    // Wording fix: the no-op line is now "Nothing to push ...", so a repair
    // run must not contain that sentence.
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("Nothing to push");
    expect(existsSync(filePath)).toBe(true);
    logSpy.mockRestore();
  });

  it("a task on the board but short of local files is re-pushed (file gap is RETRIED)", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("synced-1"));
    // 2 local files, remote reports 0 -> the task must be re-pushed so the
    // missing bytes finally upload. Before this, such a task was excluded
    // forever and the gap was permanent (prod: 601/790 files, "already pushed").
    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name: "a.png", size: 10, linkedPath: null },
      { name: "b.png", size: 10, linkedPath: null },
    ]);
    vi.stubGlobal(
      "fetch",
      withOldServerProbe(legacyCreateMock(), {
        listItems: [{ id: "synced-1", cliId: "synced-1", fileCount: 0 }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { dryRun: true });

    expect(logSpy).toHaveBeenCalledWith(
      // Wording fix: the preamble now says "N to send" instead of
      // "N task(s) to push (...)".
      expect.stringContaining("1 to send"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      // Wording fix: the re-send reason keeps its meaning ("to sync missing
      // files") without the second contradictory parenthetical.
      expect.stringContaining("to sync missing files"),
    );
    logSpy.mockRestore();
    // Break: drop the fileCount comparison -> diff is empty and the line
    // says "everything is already pushed", which is the old lie.
  });

  it("a task whose remote fileCount matches local is NOT re-pushed", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("synced-1"));
    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name: "a.png", size: 10, linkedPath: null },
    ]);
    vi.stubGlobal(
      "fetch",
      withOldServerProbe(legacyCreateMock(), {
        listItems: [{ id: "synced-1", cliId: "synced-1", fileCount: 1 }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { dryRun: true });

    expect(logSpy).toHaveBeenCalledWith(
      // Wording fix: the no-op line is now "Nothing to push ...".
      expect.stringContaining("Nothing to push"),
    );
    logSpy.mockRestore();
  });

  it("a locally deleted file (remote > local) is not a reason to re-push", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("synced-1"));
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
    vi.stubGlobal(
      "fetch",
      withOldServerProbe(legacyCreateMock(), {
        listItems: [{ id: "synced-1", cliId: "synced-1", fileCount: 3 }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { dryRun: true });

    expect(logSpy).toHaveBeenCalledWith(
      // Wording fix: the no-op line is now "Nothing to push ...".
      expect.stringContaining("Nothing to push"),
    );
    logSpy.mockRestore();
    // Break: use "!= " instead of ">" and this test goes red forever.
  });

  it("refuses before the first write when the saved board is gone (403)", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("local-1"));
    const inner = legacyCreateMock();
    const outer = withOldServerProbe(inner, { listStatus: 403 });
    vi.stubGlobal("fetch", outer);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    const result = (await push(projectDir, {})) as unknown as { tasks: number };

    // Board chosen by the user earlier no longer exists, so every create
    // would 403. Measured failure mode: the old code pushed ALL 1746 local
    // tasks anyway ("Could not read the board — attempting push of all"),
    // producing a progress bar that counted attempts while nothing landed.
    expect(inner).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(result.tasks).toBe(0);
    expect(process.exitCode).not.toBeUndefined();
    expect(
      errSpy.mock.calls.map((c) => String(c[0])).join("\n"),
    ).toContain("is not accessible (HTTP 403)");
    errSpy.mockRestore();
    process.exitCode = originalExitCode;
    // Break: fall back to "push all" on any listing error -> inner is called.
  });

  it("refuses on 401 (expired token) instead of attempting every create", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("local-1"));
    const inner = legacyCreateMock();
    vi.stubGlobal("fetch", withOldServerProbe(inner, { listStatus: 401 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    await push(projectDir, {});

    expect(inner).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBeUndefined();
    errSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("dry-run reports the same diff (to-push count + already-on-board)", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("synced-1"));
    createTaskFile(projectDir, taskRecord("new-1"));
    vi.stubGlobal(
      "fetch",
      withOldServerProbe(legacyCreateMock(), {
        listItems: [{ id: "synced-1", cliId: "synced-1" }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = (await push(projectDir, { dryRun: true })) as unknown as {
      dryRun: boolean;
      tasks: number;
    };

    expect(logSpy).toHaveBeenCalledWith(
      // Wording fix: one dry-run preamble line (local / on-board / to-send)
      // replaces the old two-parenthetical sentence.
      expect.stringContaining(
        "Dry run — push plan: 2 local task(s), 1 already on the board, 1 to send",
      ),
    );
    expect(result.tasks).toBe(1);
    logSpy.mockRestore();
  });

  // Wording fix: the no-op is now named for what it is ("Nothing to push"),
  // not for the old "Everything is already pushed" sentence.
  it("dry-run with an empty diff reports a clean no-op", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("synced-1"));
    vi.stubGlobal(
      "fetch",
      withOldServerProbe(legacyCreateMock(), {
        listItems: [{ id: "synced-1", cliId: "synced-1" }],
      }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { dryRun: true });

    expect(logSpy).toHaveBeenCalledWith(
      // Wording fix: the no-op line is now "Nothing to push ..." — a
      // zero-create is not a push, so it never reads "Pushed 0".
      expect.stringContaining("Nothing to push — board already has all 1 task(s)."),
    );
    logSpy.mockRestore();
  });

  it("--json carries skippedTasks with the exact reason; the skipped task stays local", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, taskRecord("small"));
    const bigFilePath = createTaskFile(projectDir, taskRecord("big"));
    // A real 20-byte file on the big task; the probe advertises a
    // 10-byte per-file cap → the whole task skips.
    const filesDir = join(projectDir, ".vibeflow", "files", "big");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "big.bin"), Buffer.alloc(20, 7));
    vi.mocked(filesModule.listFiles).mockImplementation(((_dir: string, taskId: string) =>
      taskId === "big"
        ? [{ name: "big.bin", size: 20, linkedPath: null }]
        : []) as unknown as typeof filesModule.listFiles);
    vi.mocked(filesModule.getFilesDir).mockReturnValue(filesDir);
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: { method?: string; body?: unknown }) => {
        if (String(url).includes("/api/v0/tasks?")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ items: [], nextCursor: null }),
          });
        }
        if (String(url).endsWith("/api/v0/tasks/import") && (init?.method ?? "GET") === "GET") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                maxTasks: 100,
                maxFiles: 50,
                maxBytes: 25 * 1024 * 1024,
                maxFileBytes: 10,
                plan: "free",
                openRemaining: 500,
                totalRemaining: 2000,
              }),
          });
        }
        const text = String((init?.body as FormData).get("manifest"));
        const manifest = JSON.parse(text) as { tasks: Array<{ clientId: string }> };
        posts.push(...manifest.tasks.map((t) => t.clientId));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              created: manifest.tasks.length,
              existing: 0,
              failed: 0,
              linksApplied: 0,
              linksFailed: 0,
              filesUploaded: 0,
              filesFailed: 0,
              filesSkipped: 0,
              results: manifest.tasks.map((t) => ({ clientId: t.clientId, id: `cloud-${t.clientId}` })),
            }),
        });
      }),
    );
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });

    // No --keep-local-files: exercises deletion scoping too (only the
    // pushed task's local file is deleted; the skipped one survives).
    await push(projectDir, { json: true });

    // Only the fitting task travelled.
    expect(posts).toEqual(["small"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1 task(s) skipped whole"));
    const envelope = logs.map((l) => {
      try {
        return JSON.parse(l) as {
          skippedTasks: Array<{ localId: string; reason: string }>;
        };
      } catch {
        return null;
      }
    }).find((p) => p !== null && Array.isArray(p.skippedTasks));
    expect(envelope?.skippedTasks).toEqual([
      {
        localId: "big",
        reason:
          'file "big.bin" (20 bytes) exceeds the per-file cap of 10 bytes — task skipped whole, retryable',
      },
    ]);
    // Never marked pushed: the local task file survives even without --keep.
    expect(existsSync(bigFilePath)).toBe(true);
    logSpy.mockRestore();
  });
});
