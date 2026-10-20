/**
 * Tree-import push client (ticket bulk-429).
 *
 * Ground truth (mocks ONLY): the import endpoint is multipart
 * `POST /api/v0/tasks/import` (manifest + ref-keyed file parts,
 * per-task `[{ id, existing? } | { error }]` in manifest order with
 * nested file/link outcomes) with `GET` doubling as capability probe +
 * quota preflight. Every test below stubs `fetch` with scripted
 * statuses and pins exact counts/URLs/bodies a naive implementation
 * would NOT produce (non-vacuity: verified red each way by flipping
 * the impl — see report).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IMPORT_MAX_TASKS,
  IMPORT_MAX_FILES,
  IMPORT_MAX_BYTES,
  BATCH_CHUNK_PACING_DELAY_MS,
  probeImportCapability,
  evaluateBatchPreflight,
  topoOrderImportTasks,
  chunkImportTasks,
  importBatchTree,
  type ImportTaskInput,
  type ImportPreflight,
} from "../../../src/saas/batch-push.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function inputs(n: number, withParent = false): ImportTaskInput[] {
  return Array.from({ length: n }, (_, i) => ({
    localId: `t${i + 1}`,
    record: {
      id: `t${i + 1}`,
      title: `T${i + 1}`,
      status: "todo",
      ...(withParent && i > 0 ? { links: [{ taskId: "t1", type: "parent" }] } : {}),
    },
    files: [],
  }));
}

function okResults(ids: string[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        created: ids.length,
        existing: 0,
        failed: 0,
        linksApplied: 0,
        linksFailed: 0,
        filesUploaded: 0,
        filesFailed: 0,
        filesSkipped: 0,
        results: ids.map((id) => ({ clientId: id, id: `cloud-${id}`, ...extra })),
      }),
  };
}

function probeOk(preflight: Partial<ImportPreflight> = {}) {
  return {
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
        ...preflight,
      }),
  };
}

function whole429(retryAfter = "5") {
  return {
    ok: false,
    status: 429,
    json: () => Promise.resolve({ code: "RATE_LIMITED", message: "slow down" }),
    headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter : null) },
  };
}

describe("import constants (ticket bulk-429)", () => {
  it("caps are 100 tasks / 50 files / 25 MB", () => {
    // Break: retune any constant without updating the server — the
    // chunk-count tests below go red.
    expect(IMPORT_MAX_TASKS).toBe(100);
    expect(IMPORT_MAX_FILES).toBe(50);
    expect(IMPORT_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("import capability probe (ticket bulk-429)", () => {
  it("200 with the envelope → supported", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(probeOk()));
    const probe = await probeImportCapability("https://x.test", "tok");
    expect(probe).toEqual({
      supported: true,
      // The server mirrors whole records, so existing tasks are re-sent for
      // reconciliation (that is what makes a re-push a repair).
      lossless: true,
      preflight: {
        maxTasks: 100,
        maxFiles: 50,
        maxBytes: 25 * 1024 * 1024,
        maxFileBytes: null,
        plan: "free",
        openLimit: 500,
        openUsed: 0,
        openRemaining: 500,
        totalLimit: 2000,
        totalUsed: 0,
        totalRemaining: 2000,
      },
    });
  });

  it("404 → unsupported (old server falls back, body never parsed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }),
    );
    expect(await probeImportCapability("https://x.test", "tok")).toEqual({
      supported: false,
    });
  });

  it("400 Invalid-task-id → unsupported (local alias artifact)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Invalid task id" }),
      }),
    );
    expect(await probeImportCapability("https://x.test", "tok")).toEqual({
      supported: false,
    });
  });

  it("401 → throws (bad token aborts before any destructive step)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(probeImportCapability("https://x.test", "tok")).rejects.toThrow();
  });

  it("200 without the envelope → unsupported (lenient, never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [], nextCursor: null }),
      }),
    );
    expect(await probeImportCapability("https://x.test", "tok")).toEqual({
      supported: false,
    });
  });
});

describe("quota preflight refuse gate", () => {
  const preflight: ImportPreflight = {
    maxTasks: 100,
    maxFiles: 50,
    maxBytes: 25 * 1024 * 1024,
    plan: "free",
    openRemaining: 500,
    totalRemaining: 2000,
  };
  it("refuses with exact numbers when open slots cannot fit the push", () => {
    const msg = evaluateBatchPreflight(501, { ...preflight, openRemaining: 500 });
    expect(msg).toContain("500 open task slot(s)");
  });
  it("refuses on the total dimension even when open fits", () => {
    const msg = evaluateBatchPreflight(10, { ...preflight, totalRemaining: 5 });
    expect(msg).toContain("5 total task slot(s)");
  });
  it("null remaining = uncapped dimension → no refusal", () => {
    expect(
      evaluateBatchPreflight(10000, { ...preflight, openRemaining: null, totalRemaining: null }),
    ).toBeNull();
  });
});

describe("topoOrderImportTasks (ticket bulk-429)", () => {
  it("parents come first; unrelated tasks keep input order", () => {
    const ordered = topoOrderImportTasks([
      { localId: "child", record: { links: [{ taskId: "parent", type: "parent" }] } },
      { localId: "other", record: {} },
      { localId: "parent", record: {} },
    ]);
    expect(ordered.map((t) => t.localId)).toEqual(["other", "parent", "child"]);
    // Break: skip the topo sort — child-first order strands the
    // cross-chunk parent as a link error below.
  });

  it("cycles append in input order (server reports them, never hangs)", () => {
    const ordered = topoOrderImportTasks([
      { localId: "a", record: { links: [{ taskId: "b", type: "parent" }] } },
      { localId: "b", record: { links: [{ taskId: "a", type: "parent" }] } },
    ]);
    expect(ordered.map((t) => t.localId)).toEqual(["a", "b"]);
  });

  it("non-parent link types never order", () => {
    const ordered = topoOrderImportTasks([
      { localId: "a", record: { links: [{ taskId: "b", type: "relates" }] } },
      { localId: "b", record: {} },
    ]);
    expect(ordered.map((t) => t.localId)).toEqual(["a", "b"]);
  });
});

describe("chunkImportTasks (ticket bulk-429)", () => {
  it("250 tasks → 3 chunks of 100/100/50", () => {
    const chunks = chunkImportTasks(inputs(250), 100);
    expect(chunks.map((c) => c.tasks.length)).toEqual([100, 100, 50]);
  });

  it("file count binds before task count", () => {
    const withFiles: ImportTaskInput[] = [
      {
        localId: "full",
        record: {},
        files: Array.from({ length: 50 }, (_, j) => ({
          name: `f${j}`,
          filePath: "p",
          size: 10,
          system: false,
        })),
      },
      {
        localId: "one-more",
        record: {},
        files: [{ name: "g", filePath: "p", size: 10, system: false }],
      },
      { localId: "empty", record: {}, files: [] },
    ];
    const chunks = chunkImportTasks(withFiles, 100);
    // 50 files fill the call; the 1-file task starts the next chunk,
    // and a fileless task still joins a non-full chunk.
    expect(chunks.map((c) => c.tasks.length)).toEqual([1, 2]);
    // Break: ignore the file dimension (100-task chunks) — 51 files
    // ride one call and the server 400s it.
  });

  it("byte cap binds before count (25 MB)", () => {
    const tenMB = 10 * 1024 * 1024;
    const withFiles: ImportTaskInput[] = [0, 1, 2].map((i) => ({
      localId: `t${i}`,
      record: {},
      files: [{ name: "f", filePath: "p", size: tenMB, system: false }],
    }));
    const chunks = chunkImportTasks(withFiles, 100);
    // 10+10 fits; the third would pass 25 MB → [2,1].
    expect(chunks.map((c) => c.tasks.length)).toEqual([2, 1]);
  });

  it("chunking is task-atomic: a task's file list is never split across chunks", () => {
    // Per-task atomicity: a 60-file task cannot share a 50-file chunk —
    // it travels WHOLE in its own chunk (the partition in importBatchTree
    // skips such tasks before chunk one; the chunker itself never splits
    // a file list, so a task is never created with only some of its files).
    const withFiles: ImportTaskInput[] = [
      {
        localId: "big",
        record: { title: "Big" },
        files: Array.from({ length: 60 }, (_, j) => ({
          name: `f${j}`,
          filePath: "p",
          size: 10,
          system: false,
        })),
      },
      { localId: "small", record: { title: "Small" }, files: [] },
    ];
    const chunks = chunkImportTasks(withFiles, 100);
    expect(chunks.map((c) => c.tasks.reduce((a, t) => a + t.files.length, 0))).toEqual([60, 0]);
    expect(chunks[0]!.tasks.map((t) => t.localId)).toEqual(["big"]);
    expect(chunks[1]!.tasks.map((t) => t.localId)).toEqual(["small"]);
    // Break: reintroduce file-list splitting — the first chunk reads 50
    // files and the task's files span two calls (partial creation).
  });
});

describe("importBatchTree chunking + honesty (ticket bulk-429)", () => {
  function chunkSpy() {
    const manifests: Array<{ tasks: Array<{ clientId: string; parentClientIds: string[]; files: unknown[] }> }> = [];
    const urls: string[] = [];
    const mock = vi.fn().mockImplementation((url: unknown, init?: { body?: unknown }) => {
      urls.push(String(url));
      // Manifest rides the multipart body — extract + parse it.
      const text = String((init?.body as FormData).get("manifest"));
      const manifest = JSON.parse(text) as { tasks: Array<{ clientId: string; parentClientIds: string[]; files: unknown[] }> };
      manifests.push(manifest);
      const ids = manifest.tasks.map((t) => t.clientId);
      return Promise.resolve(okResults(ids));
    });
    return { manifests, urls, mock };
  }

  it("250 tasks → 3 import POSTs of 100/100/50 with manifest + parent ids", async () => {
    const { manifests, urls, mock } = chunkSpy();
    vi.stubGlobal("fetch", mock);
    const result = await importBatchTree("https://x.test", "tok", "b1", inputs(250, true), {
      pacingDelayMs: 0,
    });
    expect(result.imported).toBe(250);
    expect(result.skipped).toBe(0);
    expect(urls).toEqual([
      "https://x.test/api/v0/tasks/import",
      "https://x.test/api/v0/tasks/import",
      "https://x.test/api/v0/tasks/import",
    ]);
    expect(manifests.map((m) => m.tasks.length)).toEqual([100, 100, 50]);
    // topo order: t1 (the parent) first in chunk one; every child
    // carries its local parent id for server-side resolution.
    expect(manifests[0]!.tasks[0]!.clientId).toBe("t1");
    for (const m of manifests) {
      for (const t of m.tasks) {
        if (t.clientId === "t1") expect(t.parentClientIds).toEqual([]);
        else expect(t.parentClientIds).toEqual(["t1"]);
      }
    }
    expect(result.idMap["t250"]).toBe("cloud-t250");
    // Break: post per-task (250 calls) — urls length goes 250, not 3.
  });

  it("boardId travels in the manifest", async () => {
    const { manifests, mock } = chunkSpy();
    vi.stubGlobal("fetch", mock);
    await importBatchTree("https://x.test", "tok", "board-9", inputs(2), { pacingDelayMs: 0 });
    void manifests;
    const text = String((mock.mock.calls[0]![1] as { body: FormData }).body.get("manifest"));
    expect(JSON.parse(text)).toMatchObject({ boardId: "board-9" });
  });

  it("server existing matches fill the idMap but count separately", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            created: 1,
            existing: 1,
            failed: 0,
            linksApplied: 0,
            linksFailed: 0,
            filesUploaded: 0,
            filesFailed: 0,
            filesSkipped: 0,
            results: [
              { clientId: "t1", id: "cloud-t1" },
              { clientId: "t2", id: "cloud-t2", existing: true },
            ],
          }),
      }),
    );
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(2), {
      pacingDelayMs: 0,
    });
    expect(result.imported).toBe(1);
    expect(result.existing).toBe(1);
    expect(result.idMap).toEqual({ t1: "cloud-t1", t2: "cloud-t2" });
  });

  it("per-task errors group; TASK_LIMIT stops the push", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            created: 1,
            existing: 0,
            failed: 2,
            linksApplied: 0,
            linksFailed: 0,
            filesUploaded: 0,
            filesFailed: 0,
            filesSkipped: 0,
            results: [
              { clientId: "t1", id: "cloud-t1" },
              { clientId: "t2", error: { code: "INVALID_TITLE", message: "title required" } },
              { clientId: "t3", error: { code: "TASK_LIMIT", message: "limit" } },
            ],
          }),
      }),
    );
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(3), {
      pacingDelayMs: 0,
    });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.failures).toEqual([
      { status: 400, code: "INVALID_TITLE", count: 1 },
      { status: 402, code: "TASK_LIMIT", count: 1 },
    ]);
    expect(result.stoppedEarly).toBe("plan-limit");
    expect(result.attempted).toBe(3);
  });

  it("link + file tallies aggregate without stopping the push", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            created: 1,
            existing: 0,
            failed: 0,
            linksApplied: 1,
            linksFailed: 1,
            filesUploaded: 1,
            filesFailed: 1,
            filesSkipped: 1,
            results: [
              {
                clientId: "t1",
                id: "cloud-t1",
                links: [
                  { type: "parent", taskId: "cloud-t0" },
                  { error: { code: "NOT_FOUND", message: "gone" } },
                ],
                files: [
                  { ref: "t1/a", name: "a", file: {} },
                  { ref: "t1/b", name: "b", skipped: true, file: {} },
                  { ref: "t1/c", name: "c", error: { code: "EMPTY_FILE", message: "empty" } },
                ],
              },
            ],
          }),
      }),
    );
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(1), {
      pacingDelayMs: 0,
    });
    expect(result.imported).toBe(1);
    expect(result.linksApplied).toBe(1);
    expect(result.linksFailed).toBe(1);
    expect(result.failedLinks).toEqual([{ clientId: "t1", reason: "NOT_FOUND: gone" }]);
    expect(result.filesUploaded).toBe(1);
    expect(result.filesSkippedPresent).toBe(1);
    expect(result.filesFailed).toBe(1);
    expect(result.failedFiles).toEqual([{ clientId: "t1", name: "c", reason: "EMPTY_FILE: empty" }]);
    expect(result.stoppedEarly).toBeNull();
  });

  it("whole-chunk 400 degrades to per-task failures and continues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ code: "BATCH_TOO_LARGE", message: "too big" }),
      }),
    );
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(3), {
      pacingDelayMs: 0,
    });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.failures).toEqual([{ status: 400, code: "BATCH_TOO_LARGE", count: 3 }]);
    expect(result.stoppedEarly).toBeNull();
  });
});

describe("import pacing + 429 resume (ticket bulk-429)", () => {
  it("paces between chunks with the 5s default, never before the first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown, init?: { body?: unknown }) => {
        const text = String((init?.body as FormData).get("manifest"));
        const ids = (JSON.parse(text) as { tasks: Array<{ clientId: string }> }).tasks.map(
          (t) => t.clientId,
        );
        return Promise.resolve(okResults(ids));
      }),
    );
    const slept: number[] = [];
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(250), {
      pacingSleepMs: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.imported).toBe(250);
    expect(slept).toEqual([BATCH_CHUNK_PACING_DELAY_MS, BATCH_CHUNK_PACING_DELAY_MS]);
  });

  it("pacingDelayMs: 0 disables pacing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown, init?: { body?: unknown }) => {
        const text = String((init?.body as FormData).get("manifest"));
        const ids = (JSON.parse(text) as { tasks: Array<{ clientId: string }> }).tasks.map(
          (t) => t.clientId,
        );
        return Promise.resolve(okResults(ids));
      }),
    );
    const slept: number[] = [];
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(150), {
      pacingDelayMs: 0,
      pacingSleepMs: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.imported).toBe(150);
    expect(slept).toEqual([]);
  });

  it("429 → wait → re-POST → success (no pacing on the resume re-POST)", async () => {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown, init?: { body?: unknown }) => {
        posts++;
        if (posts === 1) return Promise.resolve(whole429("5"));
        const text = String((init?.body as FormData).get("manifest"));
        const ids = (JSON.parse(text) as { tasks: Array<{ clientId: string }> }).tasks.map(
          (t) => t.clientId,
        );
        return Promise.resolve(okResults(ids));
      }),
    );
    const waited: Array<[number, number]> = [];
    const paced: number[] = [];
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(150), {
      retry429: {
        sleepMs: () => Promise.resolve(),
        onWait: (ms, n) => waited.push([ms, n]),
      },
      pacingSleepMs: (ms) => {
        paced.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.imported).toBe(150);
    expect(result.stoppedEarly).toBeNull();
    expect(waited).toEqual([[5000, 1]]);
    expect(paced).toEqual([BATCH_CHUNK_PACING_DELAY_MS]);
    // Break: `continue` instead of `c--` on 429 — chunk one's tasks are
    // never re-POSTed and imported reads 50, not 150.
  });

  it("resume-budget exhaustion stops loudly with truthful counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(whole429("5")));
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(3), {
      retry429: { maxResumes: 0, sleepMs: () => Promise.resolve() },
      pacingDelayMs: 0,
    });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.stoppedEarly).toBe("rate-limited");
    expect(result.failures).toEqual([{ status: 429, code: "RATE_LIMITED", count: 3 }]);
    // Break: swallow the tail on 429-stop — skipped reads 0 and the
    // tasks vanish silently, the exact prod failure mode.
  });

  it("per-chunk timeout + transport retry: 2 throws then success", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        calls++;
        if (calls <= 2) return Promise.reject(new Error("socket hang up"));
        return Promise.resolve(okResults(["t1"]));
      }),
    );
    const result = await importBatchTree("https://x.test", "tok", "b", inputs(1), {
      pacingDelayMs: 0,
    });
    expect(result.imported).toBe(1);
    expect(calls).toBe(3);
  });
});

describe("import checkpoint resume (ticket bulk-429)", () => {
  it("killed push persists chunk progress; rerun completes the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "import-int-"));
    try {
      const all = inputs(120);
      let chunkTwoDead = true;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: unknown, init?: { body?: unknown }) => {
          const text = String((init?.body as FormData).get("manifest"));
          const ids = (JSON.parse(text) as { tasks: Array<{ clientId: string }> }).tasks.map(
            (t) => t.clientId,
          );
          if (ids[0] === "t101" && chunkTwoDead) {
            return Promise.reject(new Error("connection reset"));
          }
          return Promise.resolve(okResults(ids));
        }),
      );
      // Chunk one (100) succeeds; chunk two's transport dies 3× → throw,
      // progress persists.
      await expect(
        importBatchTree("https://x.test", "tok", "board-i", all, {
          projectDir: dir,
          pacingDelayMs: 0,
        }),
      ).rejects.toThrow("connection reset");
      // Rerun (transport healed) POSTs only the missing tail.
      chunkTwoDead = false;
      const sizes: number[] = [];
      (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (url: unknown, init?: { body?: unknown }) => {
          const text = String((init?.body as FormData).get("manifest"));
          const ids = (JSON.parse(text) as { tasks: Array<{ clientId: string }> }).tasks.map(
            (t) => t.clientId,
          );
          sizes.push(ids.length);
          return Promise.resolve(okResults(ids));
        },
      );
      const result = await importBatchTree("https://x.test", "tok", "board-i", all, {
        projectDir: dir,
        pacingDelayMs: 0,
      });
      expect(sizes).toEqual([20]);
      expect(result.imported).toBe(20);
      expect(result.idMap["t1"]).toBe("cloud-t1");
      expect(result.idMap["t120"]).toBe("cloud-t120");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("276-link regression (ticket bulk-429)", () => {
  it("276 parent links ride 3 import calls with zero 429s against a 30/min bucket", async () => {
    // The prod incident verbatim: 276 single-link POSTs burst 44 then
    // 429'd every call past the bucket, orphaning 232 children as
    // roots. One parent + 275 children ride 3 import calls (100/100/76
    // tasks) at 1 write unit each — under any 30/min bucket, so a
    // bucket-enforcing mock must never 429 and no link may skip silently.
    const dir = mkdtempSync(join(tmpdir(), "import-276-"));
    try {
      const all: ImportTaskInput[] = [
        { localId: "parent", record: { id: "parent", title: "Parent" }, files: [] },
      ];
      for (let i = 0; i < 275; i++) {
        all.push({
          localId: `c${i}`,
          record: {
            id: `c${i}`,
            title: `Child ${i}`,
            links: [{ taskId: "parent", type: "parent" }],
          },
          files: [],
        });
      }
      let posts = 0;
      let saw429 = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: unknown, init?: { body?: unknown }) => {
          posts++;
          // Token-bucket mock (30/min per route): past 30 calls, 429.
          if (posts > 30) {
            saw429++;
            return Promise.resolve(whole429("60"));
          }
          const text = String((init?.body as FormData).get("manifest"));
          const manifest = JSON.parse(text) as {
            tasks: Array<{ clientId: string; parentClientIds?: string[] }>;
          };
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                created: manifest.tasks.length,
                existing: 0,
                failed: 0,
                linksApplied: manifest.tasks.filter((t) => (t.parentClientIds ?? []).length > 0).length,
                linksFailed: 0,
                filesUploaded: 0,
                filesFailed: 0,
                filesSkipped: 0,
                results: manifest.tasks.map((t) => ({
                  clientId: t.clientId,
                  id: `cloud-${t.clientId}`,
                  links: (t.parentClientIds ?? []).map((p) => ({ type: "parent", taskId: `cloud-${p}` })),
                })),
              }),
          });
        }),
      );
      const result = await importBatchTree("https://x.test", "tok", "b", all, {
        retry429: { maxResumes: 0, sleepMs: () => Promise.resolve() },
        pacingDelayMs: 0,
      });
      expect(result.imported).toBe(276);
      expect(result.skipped).toBe(0);
      expect(result.linksApplied).toBe(275);
      expect(result.linksFailed).toBe(0);
      expect(result.failedLinks).toEqual([]);
      expect(posts).toBe(3);
      expect(saw429).toBe(0);
      // Every child id mapped — nothing unapplied, nothing silent.
      expect(Object.keys(result.idMap)).toHaveLength(276);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Break: post per-link (276 calls) — posts reads 276, saw429 > 0,
    // linksApplied collapses: the exact prod incident, replayed in a test.
  });
});
describe("782-file regression (ticket bulk-429)", () => {
  it("782 files ride ~16 import calls with zero 429s against a 30/min bucket", async () => {
    // The prod incident verbatim at small scale: 782 single-file POSTs
    // burst 44 then 429'd every call past the bucket. Chunked at 50
    // files + 1 write unit per call, the same 782 files cost 16 units —
    // under any 30/min bucket, so a bucket-enforcing mock must never 429.
    // Per-task atomicity: every task fits an empty chunk whole (no task
    // holds more than 50 files) — over-cap tasks skip whole via the
    // partition (pinned separately), they never ride here.
    const dir = mkdtempSync(join(tmpdir(), "import-f782-"));
    try {
      const perTask = [
        25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25,
        24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
      ];
      const all: ImportTaskInput[] = [];
      perTask.forEach((n, t) => {
        const files = Array.from({ length: n }, (_, i) => {
          const name = `t${t}-${i}.bin`;
          const filePath = join(dir, name);
          writeFileSync(filePath, Buffer.alloc(3, i % 256));
          return { name, filePath, size: 3, system: false };
        });
        all.push({ localId: `rt${t}`, record: { id: `rt${t}`, title: `T${t}` }, files });
      });
      const totalFiles = all.reduce((a, t) => a + t.files.length, 0);
      expect(totalFiles).toBe(782);
      let posts = 0;
      let saw429 = 0;
      const seen = new Set<string>();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: unknown, init?: { body?: unknown }) => {
          posts++;
          // Token-bucket mock (30/min per route): past 30 calls, 429.
          if (posts > 30) {
            saw429++;
            return Promise.resolve(whole429("60"));
          }
          const text = String((init?.body as FormData).get("manifest"));
          const manifest = JSON.parse(text) as {
            tasks: Array<{ clientId: string; files: Array<{ name: string }> }>;
          };
          const names = manifest.tasks.flatMap((t) => t.files.map((f) => f.name));
          // Chunking is task-atomic (no split replays); the seen-set stays
          // as a guard — any replayed task comes back existing:true.
          const results = manifest.tasks.map((t) => {
            const existing = seen.has(t.clientId);
            seen.add(t.clientId);
            return {
              clientId: t.clientId,
              id: `cloud-${t.clientId}`,
              ...(existing ? { existing: true as const } : {}),
              files: t.files.map((f) => ({ ref: "r", name: f.name, file: {} })),
            };
          });
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                created: results.filter((r) => !("existing" in r)).length,
                existing: results.filter((r) => "existing" in r).length,
                failed: 0,
                linksApplied: 0,
                linksFailed: 0,
                filesUploaded: names.length,
                filesFailed: 0,
                filesSkipped: 0,
                results,
              }),
          });
        }),
      );
      const result = await importBatchTree("https://x.test", "tok", "b", all, {
        retry429: { maxResumes: 0, sleepMs: () => Promise.resolve() },
        pacingDelayMs: 0,
      });
      expect(result.filesUploaded).toBe(782);
      expect(result.filesFailed).toBe(0);
      expect(result.imported).toBe(32);
      expect(result.existing).toBe(0);
      expect(result.skippedTasks).toEqual([]);
      expect(posts).toBe(16);
      expect(saw429).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Break: chunk at 1 task without file awareness (782 files in 8
    // calls of ~98) — the server 400s every call and filesFailed reads
    // 782: the exact prod incident, replayed in a test.
  });
});
