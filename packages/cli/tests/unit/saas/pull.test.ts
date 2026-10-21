/**
 * Pull transport (saas/pull.ts) + refusal mapping (saas/failure.ts).
 *
 * The mapping is the whole safety story for paid-plan and cap refusals: a
 * 403 EXPORT_NOT_ALLOWED must read as "upgrade your plan" (non-retryable),
 * never as an auth failure or a transient outage — and a retry loop must
 * never fire for it. 413 is the same shape for the size cap.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { saasFailure } from "../../../src/saas/failure.js";
import {
  fetchPullArchive,
  fetchPullArchiveWithRetry,
  isPullRetryableStatus,
  readPullServerCode,
} from "../../../src/saas/pull.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function okBytes(body: Uint8Array, status = 200): Response {
  return new Response(body as unknown as BodyInit, { status });
}

function refusal(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: "refused", code }), { status });
}

function args(fetchImpl?: typeof fetch) {
  return {
    apiUrl: "https://api.example.test",
    token: "tok",
    headers: { "X-Vibeflow-Scope": "b_1" },
    boardId: "b_1",
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

describe("saasFailure — pull refusal mapping", () => {
  it("403 EXPORT_NOT_ALLOWED → E_PLAN_REQUIRED, non-retryable, with the upgrade fix", () => {
    expect(
      saasFailure({ code: "HTTP_ERROR", status: 403, serverCode: "EXPORT_NOT_ALLOWED" }),
    ).toEqual({
      code: "E_PLAN_REQUIRED",
      retryable: false,
      suggestion: "Export requires a Pro plan. Upgrade to export this board.",
    });
  });

  it("the plan refusal wins over the 403 auth mapping by serverCode", () => {
    // Without the serverCode check this exact shape mapped to
    // E_NOT_AUTHENTICATED ("log in again") — the wrong fix for a plan gate.
    const mapped = saasFailure({
      code: "HTTP_ERROR",
      status: 403,
      serverCode: "EXPORT_NOT_ALLOWED",
    });
    expect(mapped.code).not.toBe("E_NOT_AUTHENTICATED");
    expect(mapped.code).toBe("E_PLAN_REQUIRED");
  });

  it("a bare 403 without a serverCode still maps to auth (no behaviour change)", () => {
    expect(saasFailure({ code: "HTTP_ERROR", status: 403 }).code).toBe(
      "E_NOT_AUTHENTICATED",
    );
  });

  it("413 → E_EXPORT_TOO_LARGE, non-retryable", () => {
    const mapped = saasFailure({ code: "HTTP_ERROR", status: 413 });
    expect(mapped.code).toBe("E_EXPORT_TOO_LARGE");
    expect(mapped.retryable).toBe(false);
    expect(mapped.suggestion).toContain("maximum");
  });

  it("EXPORT_TOO_LARGE serverCode maps even without the status", () => {
    expect(
      saasFailure({ code: "HTTP_ERROR", serverCode: "EXPORT_TOO_LARGE" }).code,
    ).toBe("E_EXPORT_TOO_LARGE");
  });
});

describe("isPullRetryableStatus", () => {
  it.each([429, 502, 503, 504])("retries %i", (status) => {
    expect(isPullRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])("never retries %i", (status) => {
    expect(isPullRetryableStatus(status)).toBe(false);
  });
});

describe("readPullServerCode", () => {
  it("reads the v0 code envelope", () => {
    expect(
      readPullServerCode(JSON.stringify({ error: "x", code: "EXPORT_NOT_ALLOWED" })),
    ).toBe("EXPORT_NOT_ALLOWED");
  });

  it("returns null for non-JSON, missing, or empty codes", () => {
    expect(readPullServerCode("<html>nope</html>")).toBeNull();
    expect(readPullServerCode(JSON.stringify({ error: "x" }))).toBeNull();
    expect(readPullServerCode(JSON.stringify({ code: "" }))).toBeNull();
  });
});

describe("fetchPullArchive", () => {
  it("POSTs the export endpoint with the bearer token and returns the bytes", async () => {
    const bytes = gzipSync("archive");
    const fetchImpl = vi.fn(async () => okBytes(bytes)) as unknown as typeof fetch;
    const result = await fetchPullArchive(args(fetchImpl));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe(
      "https://api.example.test/api/v0/tasks/export/archive?boardId=b_1",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["X-Vibeflow-Scope"]).toBe("b_1");
  });

  it("a 403 plan refusal returns the serverCode, non-retryable", async () => {
    const fetchImpl = vi.fn(async () =>
      refusal(403, "EXPORT_NOT_ALLOWED"),
    ) as unknown as typeof fetch;
    const result = await fetchPullArchive(args(fetchImpl));
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      serverCode: "EXPORT_NOT_ALLOWED",
      retryable: false,
    });
  });

  it("a 413 cap refusal is non-retryable", async () => {
    const fetchImpl = vi.fn(async () =>
      refusal(413, "EXPORT_TOO_LARGE"),
    ) as unknown as typeof fetch;
    const result = await fetchPullArchive(args(fetchImpl));
    expect(result).toMatchObject({ ok: false, status: 413, retryable: false });
  });

  it("a transport throw returns a retryable null-status failure (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await fetchPullArchive(args(fetchImpl));
    expect(result).toMatchObject({ ok: false, status: null, retryable: true });
  });
});

describe("fetchPullArchiveWithRetry", () => {
  it("retries a transient throw, then succeeds", async () => {
    const bytes = gzipSync("archive");
    const fetchImpl = vi.fn(async () => okBytes(bytes)) as unknown as typeof fetch;
    let calls = 0;
    const flaky = (async (...a: unknown[]) => {
      calls++;
      if (calls === 1) throw new Error("reset by peer");
      return (fetchImpl as (...p: unknown[]) => Promise<Response>)(...a);
    }) as unknown as typeof fetch;
    const result = await fetchPullArchiveWithRetry(args(flaky), { sleepMs: 0 });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("never retries a plan refusal (one attempt, final)", async () => {
    const fetchImpl = vi.fn(async () =>
      refusal(403, "EXPORT_NOT_ALLOWED"),
    ) as unknown as typeof fetch;
    const result = await fetchPullArchiveWithRetry(args(fetchImpl), { sleepMs: 0 });
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts on a persistent 503", async () => {
    const fetchImpl = vi.fn(async () => refusal(503, "BAD_GATEWAY")) as unknown as typeof fetch;
    const result = await fetchPullArchiveWithRetry(args(fetchImpl), {
      maxAttempts: 3,
      sleepMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
