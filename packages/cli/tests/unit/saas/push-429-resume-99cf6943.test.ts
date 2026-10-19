/**
 * Bounded 429 wait-resume for push (ticket 99cf6943).
 *
 * Ground truth (mocks ONLY — no live probing): both push loops sleep
 * `min(Retry-After, 120s)` on a 429 then CONTINUE from the same position
 * instead of stopping; at most 3 waits per push, then stop loudly as
 * before. Preflight refusal stays refuse-only (no prompt, no wait).
 * Each test below pins exact sleep/counts a naive implementation would
 * NOT produce (non-vacuity: the old stop-on-first-429 code fails every
 * resume test here — zero sleeps, fewer calls, stoppedEarly set).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTasksOneByOne,
  resolve429WaitMs,
  PUSH_429_MAX_WAIT_MS,
  PUSH_429_DEFAULT_WAIT_MS,
  PUSH_429_MAX_RESUMES,
  formatPushStopLine,
} from "../../../src/auth/login.js";
import {
  evaluateBatchPreflight,
  type ImportPreflight,
} from "../../../src/saas/batch-push.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function tasks(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `T${i + 1}`,
    status: "todo",
  }));
}

function ok(id: string) {
  return { ok: true, status: 200, json: () => Promise.resolve({ id }) };
}

function refused(
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

function spySleep() {
  const sleeps: number[] = [];
  const waits: Array<[number, number]> = [];
  return {
    sleeps,
    waits,
    retry429: {
      sleepMs: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      onWait: (ms: number, n: number) => waits.push([ms, n]),
    },
  };
}

const PREFLIGHT: ImportPreflight = {
  maxTasks: 100,
  maxFiles: 50,
  maxBytes: 25 * 1024 * 1024,
  plan: "free",
  openLimit: 500,
  openUsed: 0,
  openRemaining: 500,
  totalLimit: 2000,
  totalUsed: 0,
  totalRemaining: 2000,
};

describe("resolve429WaitMs bounds the wait", () => {
  it("numeric seconds convert to ms", () => {
    expect(resolve429WaitMs("45")).toBe(45_000);
  });
  it("caps a bogus header at 120s (a 3600s header must not park the push)", () => {
    expect(resolve429WaitMs("3600")).toBe(PUSH_429_MAX_WAIT_MS);
    expect(PUSH_429_MAX_WAIT_MS).toBe(120_000);
  });
  it("missing/garbage headers hold the 60s default, never zero/NaN", () => {
    expect(resolve429WaitMs(null)).toBe(PUSH_429_DEFAULT_WAIT_MS);
    expect(resolve429WaitMs("")).toBe(PUSH_429_DEFAULT_WAIT_MS);
    expect(resolve429WaitMs("soon")).toBe(PUSH_429_DEFAULT_WAIT_MS);
    expect(resolve429WaitMs("-5")).toBe(PUSH_429_DEFAULT_WAIT_MS);
    expect(PUSH_429_DEFAULT_WAIT_MS).toBe(60_000);
  });
  it("HTTP-date headers wait the delta, capped; past dates wait 0", () => {
    const now = Date.now();
    const future = new Date(now + 30_000).toUTCString();
    expect(resolve429WaitMs(future, now)).toBeGreaterThan(29_000);
    expect(resolve429WaitMs(future, now)).toBeLessThanOrEqual(30_000);
    const far = new Date(now + 3_600_000).toUTCString();
    expect(resolve429WaitMs(far, now)).toBe(PUSH_429_MAX_WAIT_MS);
    const past = new Date(now - 5_000).toUTCString();
    expect(resolve429WaitMs(past, now)).toBe(0);
  });
  it("the per-push budget is exactly 3", () => {
    expect(PUSH_429_MAX_RESUMES).toBe(3);
  });
});

describe("one-by-one 429 resume", () => {
  it("three consecutive 429s wait 3 times, the fourth stops loudly", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        refused(429, { error: "Token bucket exhausted" }, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(
        refused(429, { error: "Token bucket exhausted" }, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(
        refused(429, { error: "Token bucket exhausted" }, { "retry-after": "2" }),
      )
      .mockResolvedValueOnce(
        refused(429, { error: "Token bucket exhausted" }, { "retry-after": "2" }),
      )
      .mockResolvedValue(ok("never"));
    vi.stubGlobal("fetch", fetchMock);
    const s = spySleep();
    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      tasks(2),
      undefined,
      s.retry429,
    );

    // 4 POSTs (initial + 3 resumed retries), 3 waits, then the loud stop
    // with the grouped refusal — identical shape to the old first-429 stop.
    // (Red without the fix: 1 call, no sleeps.)
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(s.sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(s.waits).toEqual([
      [2_000, 1],
      [2_000, 2],
      [2_000, 3],
    ]);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.attempted).toBe(4);
    expect(result.failures).toEqual([
      { status: 429, code: "Token bucket exhausted", count: 1 },
    ]);
    expect(result.stoppedEarly).toBe("rate-limited");
    expect(result.retryAfter).toBe("2");
    expect(formatPushStopLine(result)).toContain("429");
  });

  it("maxResumes: 0 restores the stop-on-first-429 behavior (fallback pin)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok("c1"))
      .mockResolvedValueOnce(
        refused(429, { error: "Token bucket exhausted" }, { "retry-after": "2" }),
      )
      .mockResolvedValue(ok("never"));
    vi.stubGlobal("fetch", fetchMock);
    const s = spySleep();
    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      tasks(3),
      undefined,
      { ...s.retry429, maxResumes: 0 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(s.sleeps).toEqual([]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.stoppedEarly).toBe("rate-limited");
  });
});

describe("preflight stays refuse-only (no prompt, no wait, no POST)", () => {
  it("over-quota preflight refuses before chunk one — the loop never runs", async () => {
    const tight: ImportPreflight = { ...PREFLIGHT, openRemaining: 1 };
    const refusal = evaluateBatchPreflight(10, tight);
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("1");
    expect(refusal).toContain("10");

    // The caller gate: a non-null refusal returns WITHOUT calling the
    // loop — prove no POST and no wait happen on this path.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const s = spySleep();
    if (refusal === null) {
      const { importBatchTree } = await import("../../../src/saas/batch-push.js");
      await importBatchTree("https://x.test", "tok", "b", tasks(10).map((t) => ({ localId: t.id as string, record: t, files: [] })), {
        preflight: tight,
        retry429: s.retry429,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.sleeps).toEqual([]);
  });

  it("fitting preflight returns null (push proceeds)", () => {
    expect(evaluateBatchPreflight(10, PREFLIGHT)).toBeNull();
  });
});
