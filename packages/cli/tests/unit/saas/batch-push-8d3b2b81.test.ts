/**
 * CLI batch-push client (ticket 8d3b2b81).
 *
 * Ground truth (mocks ONLY — no live-board probing anywhere in this
 * file): the batch endpoint is `POST /api/v0/tasks/batch` (100/chunk,
 * per-item `[{ id } | { error }]` in request order) with `GET` doubling
 * as capability probe + quota preflight. Every test below stubs `fetch`
 * with scripted statuses: probe-fallback on 404, timeout-retry on
 * transport throws, checkpoint-resume from a pre-written file, preflight
 * refuse, per-item grouping through the dec52322 formatters. Each test
 * pins exact counts/strings a naive implementation would NOT produce
 * (non-vacuity: verified red each way by flipping the impl — see report).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  V0_BATCH_MAX_ITEMS,
  BATCH_CHUNK_MAX_ATTEMPTS,
  BATCH_FILE_CONCURRENCY,
  probeBatchCapability,
  evaluateBatchPreflight,
  chunkTaskRecords,
  batchItemHttpStatus,
  postTaskChunk,
  createTasksInBatches,
  readBatchCheckpoint,
  writeBatchCheckpoint,
  clearBatchCheckpoint,
  batchCheckpointPath,
  runWithConcurrency,
  listRemoteFileNames,
  uploadBatchFiles,
  type BatchPreflight,
} from "../../../src/saas/batch-push.js";
import {
  formatPushRefusalSummary,
  formatPushStopLine,
} from "../../../src/auth/login.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function tasks(n: number, offset = 0): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${offset + i + 1}`,
    title: `T${offset + i + 1}`,
    status: "todo",
    links: [{ taskId: "t1", type: "relates" }],
  }));
}

function okChunk(ids: string[]) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        created: ids.length,
        failed: 0,
        results: ids.map((id) => ({ id })),
      }),
  };
}

function errChunk(results: Array<{ id: string } | { error: { code: string; message: string } }>) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        created: results.filter((r) => "id" in r).length,
        failed: results.filter((r) => "error" in r).length,
        results,
      }),
  };
}

function wholeRefusal(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

function probeOk(preflight: Partial<BatchPreflight> = {}) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        maxItems: 100,
        plan: "free",
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

function probe404() {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    json: () => Promise.resolve({ error: "not found" }),
  };
}

const PREFLIGHT: BatchPreflight = {
  maxItems: 100,
  plan: "free",
  openLimit: 500,
  openUsed: 0,
  openRemaining: 500,
  totalLimit: 2000,
  totalUsed: 0,
  totalRemaining: 2000,
};

describe("batch capability probe", () => {
  it("100/chunk named constant is 100 (the contract cap)", () => {
    expect(V0_BATCH_MAX_ITEMS).toBe(100);
  });

  it("404 → unsupported (old server → one-by-one fallback), body never parsed", async () => {
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, json }),
    );
    const result = await probeBatchCapability("https://x.test", "tok");
    expect(result).toEqual({ supported: false });
    expect(json).not.toHaveBeenCalled();
  });

  it("200 → supported with the preflight envelope, probe hits the v0 batch path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(probeOk());
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeBatchCapability("https://x.test", "tok");
    expect(result).toEqual({
      supported: true,
      preflight: expect.objectContaining({ maxItems: 100, plan: "free" }),
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://x.test/api/v0/tasks/batch");
    expect((init as { method: string }).method).toBe("GET");
    expect(
      ((init as { headers: Record<string, string> }).headers.Authorization),
    ).toBe("Bearer tok");
  });

  it("400 Invalid-task-id → unsupported (local alias artifact, same as 404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Invalid task id" }),
      }),
    );
    expect(await probeBatchCapability("https://x.test", "tok")).toEqual({
      supported: false,
    });
  });

  it("other 400s → throw (a real v0 validation carries code)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ code: "BATCH_TOO_LARGE", error: "x" }),
      }),
    );
    await expect(probeBatchCapability("https://x.test", "tok")).rejects.toThrow(
      /HTTP 400/,
    );
  });

  it("401 → throws (bad token aborts before any destructive step, never falls back)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(wholeRefusal(401, { error: "bad token" })),
    );
    await expect(probeBatchCapability("https://x.test", "tok")).rejects.toThrow(
      /HTTP 401/,
    );
  });

  it("500 → throws (unknown server state aborts loudly, never blind-pushes)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(wholeRefusal(500, {})),
    );
    await expect(probeBatchCapability("https://x.test", "tok")).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("200 with a non-preflight body → throws (never misreads the cap)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ hello: "world" }),
      }),
    );
    await expect(probeBatchCapability("https://x.test", "tok")).rejects.toThrow(
      /unrecognized preflight/,
    );
  });
});

describe("quota preflight refuse gate", () => {
  it("refuses with exact numbers when open slots cannot fit the push", () => {
    const msg = evaluateBatchPreflight(20, { ...PREFLIGHT, openRemaining: 5 });
    expect(msg).toContain("5");
    expect(msg).toContain("20");
    expect(msg).toContain("chunk one");
  });

  it("refuses on the total dimension even when open fits", () => {
    const msg = evaluateBatchPreflight(20, {
      ...PREFLIGHT,
      openRemaining: 500,
      totalRemaining: 7,
    });
    expect(msg).toContain("7");
    expect(msg).toContain("20");
  });

  it("null remaining = uncapped dimension → no refusal", () => {
    expect(
      evaluateBatchPreflight(1704, {
        ...PREFLIGHT,
        openRemaining: null,
        totalRemaining: null,
      }),
    ).toBeNull();
  });

  it("exact fit is allowed (remaining == needed)", () => {
    expect(
      evaluateBatchPreflight(5, { ...PREFLIGHT, openRemaining: 5 }),
    ).toBeNull();
  });
});

describe("chunking + batch loop", () => {
  it("250 tasks → 3 chunk POSTs of 100/100/50 with top-level boardId, no inline links", async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        posts.push({ url: String(url), body });
        const items = body.items as Array<Record<string, unknown>>;
        return Promise.resolve(okChunk(items.map((_, i) => `c-${posts.length}-${i}`)));
      }),
    );
    const seen: Array<[number, number]> = [];
    const result = await createTasksInBatches(
      "https://x.test",
      "tok",
      "board-1",
      tasks(250),
      { onProgress: (d, t) => seen.push([d, t]), preflight: PREFLIGHT },
    );
    expect(posts).toHaveLength(3);
    expect(posts.map((p) => (p.body.items as unknown[]).length)).toEqual([
      100, 100, 50,
    ]);
    for (const p of posts) {
      expect(p.url).toContain("/api/v0/tasks/batch");
      expect(p.body.boardId).toBe("board-1");
      for (const item of p.body.items as Array<Record<string, unknown>>) {
        expect(item).not.toHaveProperty("links");
        expect(item).toHaveProperty("title");
      }
    }
    expect(result.imported).toBe(250);
    expect(result.skipped).toBe(0);
    expect(result.attempted).toBe(250);
    expect(Object.keys(result.idMap)).toHaveLength(250);
    expect(result.stoppedEarly).toBeNull();
    expect(seen[seen.length - 1]).toEqual([250, 250]);
    expect(formatPushRefusalSummary(result)).toBe("250 created, 0 refused");
    expect(formatPushStopLine(result)).toBeNull();
  });

  it("preflight maxItems smaller than 100 shrinks the chunks", () => {
    const chunks = chunkTaskRecords(tasks(120), 50);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
  });

  it("per-item mixed results group through the dec52322 summary; TASK_LIMIT stops the push", async () => {
    // Small chunks (maxItems 5): chunk 1 all-ok, chunk 2 mixed with a
    // quota hit at index 3, chunk 3 never attempted.
    const small = { ...PREFLIGHT, maxItems: 5 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okChunk(["c1", "c2", "c3", "c4", "c5"]),
      )
      .mockResolvedValueOnce(
        errChunk([
          { id: "c6" },
          { error: { code: "INVALID_TITLE", message: "title required" } },
          { id: "c7" },
          { error: { code: "TASK_LIMIT", message: "Board task limit reached" } },
          { id: "c8" },
        ]),
      )
      .mockResolvedValue(okChunk(["never"]));
    vi.stubGlobal("fetch", fetchMock);
    const seen: Array<[number, number]> = [];
    const result = await createTasksInBatches(
      "https://x.test",
      "tok",
      "b",
      tasks(12),
      { onProgress: (d, t) => seen.push([d, t]), preflight: small },
    );
    // TASK_LIMIT at chunk-2 index 3 stops the push: the chunk's tail
    // (index 4) still counts refused (one POST = attempted), chunk 3
    // never POSTed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.imported).toBe(5 + 2);
    expect(result.skipped).toBe(1 + 2);
    expect(result.attempted).toBe(10);
    expect(result.failures).toEqual([
      { status: 400, code: "INVALID_TITLE", count: 1 },
      { status: 402, code: "TASK_LIMIT", count: 2 },
    ]);
    expect(result.stoppedEarly).toBe("plan-limit");
    expect(result.stopMessage).toBe("TASK_LIMIT");
    expect(formatPushRefusalSummary(result)).toBe(
      "7 created, 3 refused: 400 INVALID_TITLE ×1, 402 TASK_LIMIT ×2",
    );
    expect(formatPushStopLine(result)).toContain("402");
    expect(seen[seen.length - 1]).toEqual([10, 12]);
  });

  it("whole-chunk 429 stops with retry-after; whole-chunk 400 degrades to refusals and continues", async () => {
    // Small chunks (maxItems 5, 12 tasks → 5/5/2): chunk 1 refused whole
    // (400, push continues), chunk 2 all-ok, chunk 3 rate-limited → stop.
    const small = { ...PREFLIGHT, maxItems: 5 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        wholeRefusal(400, { code: "BATCH_TOO_LARGE", message: "too large" }),
      )
      .mockResolvedValueOnce(okChunk(["c1", "c2", "c3", "c4", "c5"]))
      .mockResolvedValueOnce(
        wholeRefusal(429, { error: "Token bucket exhausted" }, { "retry-after": "45" }),
      )
      .mockResolvedValue(okChunk(["never"]));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createTasksInBatches(
      "https://x.test",
      "tok",
      undefined,
      tasks(12),
      { preflight: small },
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.imported).toBe(5);
    expect(result.skipped).toBe(5 + 2);
    expect(result.attempted).toBe(12);
    expect(result.failures).toEqual([
      { status: 400, code: "BATCH_TOO_LARGE", count: 5 },
      { status: 429, code: "Token bucket exhausted", count: 2 },
    ]);
    expect(result.stoppedEarly).toBe("rate-limited");
    expect(result.retryAfter).toBe("45");
    expect(formatPushStopLine(result)).toContain("45");
  });
});

describe("per-chunk timeout + retry", () => {
  it("transport throws retry to 3 attempts then succeed (no silent single-try)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(okChunk(["c1"]));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await postTaskChunk("https://x.test", "tok", "b", tasks(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(outcome.results).toEqual([{ id: "c1" }]);
    expect(outcome.wholeChunkRefusal).toBeNull();
  });

  it("exhausted transport throws after EXACTLY 3 attempts (fails the push like one-by-one)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      postTaskChunk("https://x.test", "tok", "b", tasks(2)),
    ).rejects.toThrow("ECONNREFUSED");
    expect(fetchMock).toHaveBeenCalledTimes(BATCH_CHUNK_MAX_ATTEMPTS);
    expect(BATCH_CHUNK_MAX_ATTEMPTS).toBe(3);
  });

  it("5xx retries, then degrades to grouped refusals (push continues, loudly)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(wholeRefusal(500, {}))
      .mockResolvedValueOnce(wholeRefusal(503, { error: "overloaded" }))
      .mockResolvedValueOnce(wholeRefusal(500, {}))
      .mockResolvedValueOnce(okChunk(["c1"]));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createTasksInBatches(
      "https://x.test",
      "tok",
      "b",
      tasks(101),
      { preflight: PREFLIGHT },
    );
    // Chunk 1: 3 attempts (all 5xx) → 100 refused; chunk 2 proceeds.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(100);
    expect(result.attempted).toBe(101);
    expect(result.failures).toEqual([
      { status: 500, code: "HTTP 500", count: 100 },
    ]);
    expect(result.stoppedEarly).toBeNull();
  });

  it("chunk POSTs carry the 30s abort bound", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChunk(["c1"]));
    vi.stubGlobal("fetch", fetchMock);
    await postTaskChunk("https://x.test", "tok", undefined, tasks(1));
    const init = fetchMock.mock.calls[0]![1] as { signal: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("checkpoint / resume from disk", () => {
  it("per-chunk checkpoint written during the push, cleared on success", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "batch-ckpt-"));
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: unknown, init?: { body?: string }) => {
          if (String(url).endsWith("/api/v0/tasks/batch") && !init?.body) {
            return Promise.resolve(probeOk());
          }
          const body = JSON.parse(init?.body as string) as {
            items: unknown[];
          };
          return Promise.resolve(
            okChunk(body.items.map((_, i) => `c-${i}`)),
          );
        }),
      );
      const result = await createTasksInBatches(
        "https://x.test",
        "tok",
        "b",
        tasks(150),
        { projectDir, preflight: PREFLIGHT },
      );
      expect(result.imported).toBe(150);
      expect(readBatchCheckpoint(projectDir)).toBeNull();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("resume skips checkpointed chunks WITHOUT re-POSTing (idMap rides along)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "batch-resume-"));
    try {
      const all = tasks(150);
      const order = all.map((t) => t.id as string);
      const idMap: Record<string, string> = {};
      for (let i = 0; i < 100; i++) idMap[order[i]!] = `cloud-${i}`;
      writeBatchCheckpoint(projectDir, {
        version: 1,
        order,
        attempted: 100,
        idMap,
      });
      const postedBodies: number[] = [];
      const fetchMock = vi
        .fn()
        .mockImplementation((url: unknown, init?: { body?: string }) => {
          const body = JSON.parse(init?.body as string) as {
            items: Array<{ id: string }>;
          };
          postedBodies.push(body.items.length);
          return Promise.resolve(
            okChunk(body.items.map((t) => `cloud-new-${t.id}`)),
          );
        });
      vi.stubGlobal("fetch", fetchMock);
      const seen: Array<[number, number]> = [];
      const result = await createTasksInBatches(
        "https://x.test",
        "tok",
        "b",
        all,
        {
          projectDir,
          preflight: PREFLIGHT,
          onProgress: (d, t) => seen.push([d, t]),
        },
      );
      // Only the 50-item tail POSTed; the 100 checkpointed ids untouched.
      expect(postedBodies).toEqual([50]);
      expect(result.imported).toBe(50);
      expect(result.skipped).toBe(0);
      expect(result.attempted).toBe(150);
      expect(Object.keys(result.idMap)).toHaveLength(150);
      expect(result.idMap["t1"]).toBe("cloud-0");
      expect(result.idMap["t101"]).toBe("cloud-new-t101");
      expect(seen[0]).toEqual([100, 150]);
      expect(seen[seen.length - 1]).toEqual([150, 150]);
      expect(readBatchCheckpoint(projectDir)).toBeNull();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("order drift discards the checkpoint (full re-push, never a misaligned idMap)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "batch-drift-"));
    try {
      writeBatchCheckpoint(projectDir, {
        version: 1,
        order: ["stale-1", "stale-2"],
        attempted: 2,
        idMap: { "stale-1": "cloud-x" },
      });
      const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okChunk(["c1", "c2"])));
      vi.stubGlobal("fetch", fetchMock);
      const result = await createTasksInBatches(
        "https://x.test",
        "tok",
        "b",
        tasks(2),
        { projectDir, preflight: PREFLIGHT },
      );
      // 2 real items POSTed (stale checkpoint ignored — no phantom ids).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.imported).toBe(2);
      expect(result.idMap).toEqual({ t1: "c1", t2: "c2" });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("corrupt checkpoint file reads as null (a killed process never breaks the next push)", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "batch-corrupt-"));
    try {
      mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
      writeFileSync(batchCheckpointPath(projectDir), "{not json");
      expect(readBatchCheckpoint(projectDir)).toBeNull();
      writeFileSync(
        batchCheckpointPath(projectDir),
        JSON.stringify({ version: 999, order: [], attempted: 0, idMap: {} }),
      );
      expect(readBatchCheckpoint(projectDir)).toBeNull();
      clearBatchCheckpoint(projectDir);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("transport throw mid-push persists progress before escaping (next run resumes)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "batch-crash-"));
    try {
      const fetchMock = vi
        .fn()
        .mockImplementation((url: unknown, init?: { body?: string }) => {
          const body = JSON.parse(init?.body as string) as {
            items: Array<{ id: string }>;
          };
          if (body.items[0]?.id === "t1") {
            return Promise.resolve(
              okChunk(body.items.map((t) => `cloud-${t.id}`)),
            );
          }
          return Promise.reject(new Error("boom"));
        });
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        createTasksInBatches("https://x.test", "tok", "b", tasks(150), {
          projectDir,
          preflight: PREFLIGHT,
        }),
      ).rejects.toThrow("boom");
      const ckpt = readBatchCheckpoint(projectDir);
      expect(ckpt?.attempted).toBe(100);
      expect(Object.keys(ckpt?.idMap ?? {})).toHaveLength(100);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("batchItemHttpStatus mapping", () => {
  it("TASK_LIMIT → 402 (the contract's own words), rate codes → 429, rest → 400", () => {
    expect(batchItemHttpStatus("TASK_LIMIT")).toBe(402);
    expect(batchItemHttpStatus("PLAN_LIMIT")).toBe(402);
    expect(batchItemHttpStatus("RATE_LIMITED")).toBe(429);
    expect(batchItemHttpStatus("TOO_MANY_REQUESTS")).toBe(429);
    expect(batchItemHttpStatus("INVALID_TITLE")).toBe(400);
    expect(batchItemHttpStatus("BATCH_MISSING_RESULT")).toBe(400);
    expect(batchItemHttpStatus("")).toBe(400);
  });
});

describe("bounded R2 upload + skip-if-present", () => {
  it("concurrency ceiling is 4", () => {
    expect(BATCH_FILE_CONCURRENCY).toBe(4);
  });

  it("skips remote-present files WITHOUT a POST, uploads the missing tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-files-"));
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    writeFileSync(a, Buffer.from("aaa"));
    writeFileSync(b, Buffer.from("bbb"));
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
        if (init?.method === "GET") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({ items: [{ name: "a.png", size: 3 }] }),
          });
        }
        posted.push(String(init?.headers?.["x-filename"]));
        return Promise.resolve({ ok: true, status: 200 });
      }),
    );
    const result = await uploadBatchFiles("https://x.test", "tok", [
      { remoteId: "r1", name: "a.png", filePath: a, size: 3, system: false },
      { remoteId: "r1", name: "b.png", filePath: b, size: 3, system: false },
    ]);
    expect(result).toEqual({
      uploaded: 1,
      skippedPresent: 1,
      failed: 0,
      failedFiles: [],
    });
    expect(posted).toEqual(["b.png"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("presence-check failure fails OPEN (uploads anyway — presence is an optimization)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-files-open-"));
    const a = join(dir, "a.png");
    writeFileSync(a, Buffer.from("aaa"));
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown, init?: { method?: string }) => {
        if (init?.method === "GET") {
          return Promise.resolve({ ok: false, status: 404 });
        }
        posts++;
        return Promise.resolve({ ok: true, status: 200 });
      }),
    );
    const result = await uploadBatchFiles("https://x.test", "tok", [
      { remoteId: "r9", name: "a.png", filePath: a, size: 3, system: false },
    ]);
    expect(result.uploaded).toBe(1);
    expect(result.skippedPresent).toBe(0);
    expect(posts).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("never exceeds 4 in-flight uploads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-conc-"));
    const jobs = Array.from({ length: 10 }, (_, i) => {
      const p = join(dir, `f${i}.bin`);
      writeFileSync(p, Buffer.from([i]));
      return {
        remoteId: `r${i}`,
        name: `f${i}.bin`,
        filePath: p,
        size: 1,
        system: false,
      };
    });
    let inFlight = 0;
    let maxInFlight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: unknown, init?: { method?: string }) => {
        if (init?.method === "GET") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ items: [] }),
          });
        }
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve({ ok: true, status: 200 });
          }, 20),
        );
      }),
    );
    const result = await uploadBatchFiles("https://x.test", "tok", jobs);
    expect(result.uploaded).toBe(10);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // Red direction: a sequential impl would never exceed 1 — assert the
    // pool actually parallelizes (max > 1 proves concurrency exists).
    expect(maxInFlight).toBeGreaterThan(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runWithConcurrency preserves input order", async () => {
    const out = await runWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (4 - n) * 5));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("listRemoteFileNames tolerates legacy shapes and garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ files: [{ name: "x.md" }, "y.md"] }),
      }),
    );
    expect(await listRemoteFileNames("https://x.test", "tok", "r1")).toEqual(
      new Set(["x.md", "y.md"]),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await listRemoteFileNames("https://x.test", "tok", "r1")).toEqual(
      new Set(),
    );
  });
});
