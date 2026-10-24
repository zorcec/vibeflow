import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
}));

// Keep the create-routing test on microtasks only: the real peek reads the
// workspace file (real I/O), which does not interleave with fake-timer
// advancement. The real fetchWithTimeout tests above already prove timing.
vi.mock("../../../src/auth/board-scope.js", () => ({
  scopeHeaderFor: () => ({}),
  peekBoardScope: vi.fn().mockResolvedValue(null),
}));

import * as tokenModule from "../../../src/auth/token.js";
import { createSaasTask } from "../../../src/saas/client.js";
import {
  DEFAULT_SAAS_REQUEST_TIMEOUT_MS,
  SAAS_UPLOAD_TIMEOUT_MS,
  SaasRequestTimeoutError,
  fetchWithTimeout,
  isSaasRequestTimeout,
  parseFallback,
  redactSaasUrl,
} from "../../../src/saas/request.js";

/**
 * The bound is the fix (ticket d13fa9f5): a hung headers/body exchange
 * must fail at the deadline, naming the phase — never hang the command.
 * Fake timers prove the deadline; a real stub server proves a real fetch
 * actually aborts (no mocked-fetch-only confidence).
 */

function abortRejectingFetch() {
  let observed: AbortSignal | null = null;
  const fetchMock = vi.fn(
    (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        observed = (init?.signal as AbortSignal | null) ?? null;
        const signal = observed;
        const onAbort = (): void =>
          reject(new DOMException("This operation was aborted", "AbortError"));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    observedSignal: (): AbortSignal | null => observed,
  };
}

function headersThenStallFetch() {
  let observed: AbortSignal | null = null;
  const fetchMock = vi.fn(
    (_url: string, init?: RequestInit): Promise<Response> => {
      observed = (init?.signal as AbortSignal | null) ?? null;
      const signal = observed;
      const hangingBody = (): Promise<string> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(new DOMException("This operation was aborted", "AbortError")),
            { once: true },
          );
        });
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: hangingBody,
        json: (): Promise<unknown> => hangingBody().then(JSON.parse),
        arrayBuffer: (): Promise<ArrayBuffer> =>
          hangingBody().then((s) => new TextEncoder().encode(s).buffer as ArrayBuffer),
        blob: (): Promise<Blob> => hangingBody().then((s) => new Blob([s])),
      } as unknown as Response);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.VIBEFLOW_API_URL;
});

describe("saas request deadline", () => {
  it("documents the budgets: 30s default, 120s upload override", () => {
    // A mutant retuning these constants must fail here, loudly.
    expect(DEFAULT_SAAS_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(SAAS_UPLOAD_TIMEOUT_MS).toBe(120_000);
  });

  it("a stalled headers wait fails at the deadline, naming the phase", async () => {
    vi.useFakeTimers();
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    const { observedSignal } = abortRejectingFetch();
    const outcome = fetchWithTimeout(
      "https://board.example.com/api/v0/tasks",
      undefined,
      { phase: "POST (task-create)" },
    ).then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await outcome;
    expect(isSaasRequestTimeout(err)).toBe(true);
    const timeout = err as SaasRequestTimeoutError;
    expect(timeout.phase).toBe("POST (task-create)");
    expect(timeout.timeoutMs).toBe(30_000);
    expect(timeout.message).toContain("POST (task-create)");
    expect(timeout.message).toContain("https://board.example.com/api/v0/tasks");
    expect(observedSignal()?.aborted).toBe(true);
    // No pending deadline may outlive the operation (timer leak = hang).
    expect(vi.getTimerCount()).toBe(0);
  });

  it("headers received but body stalled still loses to the deadline", async () => {
    vi.useFakeTimers();
    headersThenStallFetch();
    const res = await fetchWithTimeout(
      "https://board.example.com/api/v0/tasks",
      undefined,
      { phase: "board-resolution" },
    );
    const outcome = res.text().then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await outcome;
    expect(isSaasRequestTimeout(err)).toBe(true);
    expect((err as Error).message).toContain("board-resolution");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fast success clears every timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve('{"ok":true}'),
        json: () => Promise.resolve({ ok: true }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        blob: () => Promise.resolve(new Blob()),
      }),
    );
    const res = await fetchWithTimeout("https://board.example.com/x", undefined, {
      phase: "board-resolution",
    });
    await expect(res.json()).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the upload override survives 30s and is bounded at 120s", async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            observed = (init?.signal as AbortSignal | null) ?? null;
            const timer = setTimeout(
              () =>
                _resolve({
                  ok: true,
                  status: 200,
                  headers: { get: () => "application/json" },
                  text: () => Promise.resolve("{}"),
                  json: () => Promise.resolve({}),
                  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
                  blob: () => Promise.resolve(new Blob()),
                } as unknown as Response),
              40_000,
            );
            observed?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new DOMException("aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      ),
    );
    // An ordinary request would die at 30s; the upload budget holds past it.
    const pending = fetchWithTimeout("https://board.example.com/upload", undefined, {
      phase: "POST (file-upload)",
      timeoutMs: SAAS_UPLOAD_TIMEOUT_MS,
    }).then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(observed?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe("resolved");
    expect(vi.getTimerCount()).toBe(0);

    // …but the override is still a bound, not an escape hatch.
    abortRejectingFetch();
    const doomed = fetchWithTimeout("https://board.example.com/upload", undefined, {
      phase: "POST (file-upload)",
      timeoutMs: SAAS_UPLOAD_TIMEOUT_MS,
    }).then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(isSaasRequestTimeout(await doomed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("redacts credentials from the timeout URL", () => {
    const redacted = redactSaasUrl(
      "https://user:pass@board.example.com/api/v0/tasks?token=s3cr3t&boardId=b1#frag",
    );
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).not.toContain("user");
    expect(redacted).not.toContain("pass");
    expect(redacted).not.toContain("#frag");
    expect(redacted).toContain("board.example.com");
    expect(redacted).toContain("boardId=b1");
    expect(redactSaasUrl("not a url")).toBe("[unparseable-url]");
  });

  it("a caller abort stays a caller abort, never a timeout", async () => {
    vi.useFakeTimers();
    abortRejectingFetch();
    const caller = new AbortController();
    const outcome = fetchWithTimeout("https://board.example.com/x", { signal: caller.signal }, {
      phase: "board-resolution",
    }).then(
      () => "resolved",
      (err: unknown) => err,
    );
    caller.abort();
    const err = await outcome;
    expect(isSaasRequestTimeout(err)).toBe(false);
    expect(err instanceof Error ? err.name : "").toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("parseFallback rethrows deadlines but keeps old recovery", () => {
    const timeout = new SaasRequestTimeoutError("POST (task-create)", "POST", "https://x", 1);
    expect(() => parseFallback("fb")(timeout)).toThrow(timeout);
    expect(parseFallback("fb")(new SyntaxError("bad json"))).toBe("fb");
  });

  it("createSaasTask routes through the deadline and marks the timeout", async () => {
    vi.useFakeTimers();
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    abortRejectingFetch();
    const outcome = createSaasTask({ title: "Timed out add" }).then((r) => r);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NETWORK_ERROR");
    expect(result.error.message).toContain("POST (task-create)");
    expect(result.error.timeout).toEqual({
      phase: "POST (task-create)",
      timeoutMs: 30_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("saas request deadline against a real stub server", () => {
  it("aborts a never-responding server and a stalled body", async () => {
    const { createServer } = await import("node:http");
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((req, res) => {
      if (req.url === "/headers-then-stall") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"partial":');
        return; // headers sent, body never finishes
      }
      // never respond at all: no headers, no body
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as unknown as { port: number };
      await expect(
        fetchWithTimeout(`http://127.0.0.1:${port}/no-headers`, undefined, {
          phase: "POST (task-create)",
          timeoutMs: 150,
        }),
      ).rejects.toThrowError(/POST \(task-create\).*127\.0\.0\.1/);
      const res = await fetchWithTimeout(
        `http://127.0.0.1:${port}/headers-then-stall`,
        undefined,
        { phase: "board-resolution", timeoutMs: 150 },
      );
      await expect(res.text()).rejects.toThrowError(/board-resolution/);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
