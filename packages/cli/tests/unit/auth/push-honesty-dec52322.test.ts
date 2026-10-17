/**
 * Push honesty (ticket dec52322).
 *
 * Ground truth (no live probing — every test below stubs `fetch`): the
 * owner pushed 1704 tasks, 60 × 2xx persist on the board, 1644 refused.
 * POST /api/v0/tasks has NO duplicate detection, so "already existed"
 * NEVER happens; the old loop counted every non-ok as a generic `skipped`
 * with res.status swallowed. These tests pin the fix with scripted
 * statuses ONLY: 402 mid-stream → loop stops + plan message; 429 →
 * stops + retry-after; mixed 400/402 → exact grouped counts; all-ok →
 * behavior unchanged (the 7db36f78 k/N progress invariant holds).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createTasksOneByOne,
  formatPushRefusalSummary,
  formatPushStopLine,
  formatSkippedLinks,
  pushRefusalCode,
} from "../../../src/auth/login.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function tasks(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `T${i + 1}`,
    status: "todo",
  }));
}

describe("createTasksOneByOne records true refusal reasons", () => {
  it("stops at the first 402 and reports the server TASK_LIMIT message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok("c1"))
      .mockResolvedValueOnce(ok("c2"))
      .mockResolvedValueOnce(
        refused(402, { code: "TASK_LIMIT", error: "Board task limit reached" }),
      )
      .mockResolvedValue(ok("never"));
    vi.stubGlobal("fetch", fetchMock);

    const seen: Array<[number, number]> = [];
    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      tasks(5),
      (done, total) => seen.push([done, total]),
    );

    // Further POSTs are futile: exactly 3 attempts, tasks 4–5 untouched.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.attempted).toBe(3);
    expect(result.failures).toEqual([
      { status: 402, code: "TASK_LIMIT", count: 1 },
    ]);
    expect(result.stoppedEarly).toBe("plan-limit");
    expect(result.stopMessage).toBe("TASK_LIMIT");
    expect(result.retryAfter).toBeNull();
    // The 7db36f78 invariant holds: refused tasks still advance k/N.
    expect(seen).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
    ]);
    expect(formatPushRefusalSummary(result)).toBe(
      "2 created, 1 refused: 402 TASK_LIMIT ×1",
    );
    expect(formatPushStopLine(result)).toContain("402");
    expect(formatPushStopLine(result)).toContain("TASK_LIMIT");
  });

  it("stops at the first 429 and records the retry-after header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok("c1"))
      .mockResolvedValueOnce(
        refused(429, { error: "Token bucket exhausted" }, { "retry-after": "120" }),
      )
      .mockResolvedValue(ok("never"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      tasks(4),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.attempted).toBe(2);
    expect(result.failures).toEqual([
      { status: 429, code: "Token bucket exhausted", count: 1 },
    ]);
    expect(result.stoppedEarly).toBe("rate-limited");
    expect(result.retryAfter).toBe("120");
    const line = formatPushStopLine(result);
    expect(line).toContain("429");
    expect(line).toContain("120");
  });

  it("groups mixed 400/402 refusals with exact counts and keeps going past 400s", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok("c1"))
      .mockResolvedValueOnce(
        refused(400, { code: "VALIDATION", error: "parent target unknown" }),
      )
      .mockResolvedValueOnce(ok("c3"))
      .mockResolvedValueOnce(
        refused(400, { code: "VALIDATION", error: "parent target unknown" }),
      )
      .mockResolvedValueOnce(
        refused(402, { code: "TASK_LIMIT", error: "limit" }),
      )
      .mockResolvedValue(ok("never"));
    vi.stubGlobal("fetch", fetchMock);

    const seen: Array<[number, number]> = [];
    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      tasks(6),
      (done, total) => seen.push([done, total]),
    );

    // 400s do NOT stop the loop (validation is per-task); the 402 does.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(3);
    expect(result.attempted).toBe(5);
    expect(result.failures).toEqual([
      { status: 400, code: "VALIDATION", count: 2 },
      { status: 402, code: "TASK_LIMIT", count: 1 },
    ]);
    expect(result.stoppedEarly).toBe("plan-limit");
    expect(seen).toEqual([
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
      [5, 6],
    ]);
    expect(formatPushRefusalSummary(result)).toBe(
      "2 created, 3 refused: 400 VALIDATION ×2, 402 TASK_LIMIT ×1",
    );
  });

  it("all-ok pushes are unchanged: no failures, no early stop, N/N progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(ok("cloud-x")),
    );
    const seen: Array<[number, number]> = [];
    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      tasks(3),
      (done, total) => seen.push([done, total]),
    );

    expect(result).toEqual({
      imported: 3,
      skipped: 0,
      idMap: { t1: "cloud-x", t2: "cloud-x", t3: "cloud-x" },
      attempted: 3,
      failures: [],
      stoppedEarly: null,
      stopMessage: null,
      retryAfter: null,
    });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(formatPushRefusalSummary(result)).toBe("3 created, 0 refused");
    expect(formatPushStopLine(result)).toBeNull();
  });

  it("a bodyless 500 groups by status and does NOT stop the loop (non-vacuity red)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(ok("c2"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      tasks(2),
    );

    // Red direction: only 402/429 stop — a 500 is attempted past.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failures).toEqual([{ status: 500, code: "HTTP 500", count: 1 }]);
    expect(result.stoppedEarly).toBeNull();
  });
});

describe("pushRefusalCode prefers code over error over message", () => {
  it("picks code first, trims and caps long messages, falls back to HTTP status", () => {
    expect(pushRefusalCode(402, { code: "TASK_LIMIT", error: "other" })).toBe(
      "TASK_LIMIT",
    );
    expect(pushRefusalCode(429, { error: "  bucket empty  " })).toBe(
      "bucket empty",
    );
    expect(pushRefusalCode(400, { message: "bad parent" })).toBe("bad parent");
    expect(pushRefusalCode(400, null)).toBe("HTTP 400");
    expect(pushRefusalCode(500, {})).toBe("HTTP 500");
    expect(pushRefusalCode(422, { code: 42 })).toBe("HTTP 422");
    expect(pushRefusalCode(400, { error: "x".repeat(200) })).toHaveLength(120);
  });
});

describe("formatSkippedLinks groups by type, truncates unless verbose", () => {
  const links = [
    { from: "a", to: "ghost", type: "relates", reason: "link target is not part of this push" },
    { from: "b", to: "ghost", type: "relates", reason: "link target is not part of this push" },
    { from: "c", to: "ghost", type: "relates", reason: "link target is not part of this push" },
    { from: "d", to: "ghost", type: "relates", reason: "link target is not part of this push" },
    { from: "e", to: "ghost", type: "relates", reason: "link target is not part of this push" },
    { from: "f", to: "ghost", type: "relates", reason: "link target is not part of this push" },
    { from: "g", to: "h", type: "parent", reason: "HTTP 500" },
  ];

  it("summarizes by type with the first few, hiding the rest", () => {
    const line = formatSkippedLinks(links, false);
    expect(line).toContain("Skipped 7 links (relates ×6, parent ×1)");
    expect(line).toContain("a→ghost (relates)");
    expect(line).not.toContain("f→ghost");
    expect(line).toContain("… and 2 more (re-run with --verbose for the full list)");
  });

  it("lists every link when verbose", () => {
    const line = formatSkippedLinks(links, true);
    expect(line).toContain("Skipped 7 links (relates ×6, parent ×1)");
    for (const l of links) {
      expect(line).toContain(`${l.from}→${l.to} (${l.type})`);
    }
    expect(line).not.toContain("more (re-run");
  });
});
