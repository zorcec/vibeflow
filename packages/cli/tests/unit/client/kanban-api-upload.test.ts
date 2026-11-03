// @vitest-environment jsdom
/**
 * CLI board kanban API client — uploadFile error surfacing.
 *
 * Parity with the web adapter (web tests/unit/kanban-api.test.ts): a
 * rejected upload POST must throw with the server error detail so the
 * detail panel lands it in the visible upload-error box instead of
 * showing the chip as success.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../../../src/client/kanban/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("api.uploadFile", () => {
  it("resolves silently on success", async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });
    await api.uploadFile("t1", new File(["x"], "a.txt"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/api/tasks/t1/files/a.txt`);
    expect(init.method).toBe("POST");
  });

  it("surfaces a rejected upload response with server error detail (413)", async () => {
    stubFetch({
      ok: false,
      status: 413,
      json: async () => ({ error: "File too large" }),
    });
    await expect(
      api.uploadFile("t1", new File(["x"], "a.txt")),
    ).rejects.toThrow("File too large");
  });

  it("falls back to the HTTP status when the error body is not JSON", async () => {
    stubFetch({
      ok: false,
      status: 413,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(
      api.uploadFile("t1", new File(["x"], "a.txt")),
    ).rejects.toThrow("HTTP 413");
  });

  it("propagates a network failure instead of resolving as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    await expect(
      api.uploadFile("t1", new File(["x"], "a.txt")),
    ).rejects.toThrow("Failed to fetch");
  });
});
