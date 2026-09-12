// @vitest-environment jsdom
/**
 * CLI kanban API client — per-user read-state calls.
 *
 * The board persists per-user state through two dedicated routes; these tests
 * pin the request shape (method, path, body) that `expandedBy` relies on.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../../../src/client/kanban/api.js";

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({}),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.markOpened", () => {
  it("POSTs to /api/tasks/:id/opened", async () => {
    const fetchMock = mockFetch();
    await api.markOpened("task-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/api/tasks/task-1/opened`);
    expect(init.method).toBe("POST");
  });

  it("encodes the task id", async () => {
    const fetchMock = mockFetch();
    await api.markOpened("task/with/slashes");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("task%2Fwith%2Fslashes");
  });
});

describe("api.setTaskExpanded", () => {
  it("POSTs the expanded flag to /api/tasks/:id/expanded", async () => {
    const fetchMock = mockFetch();
    await api.setTaskExpanded("task-1", true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${window.location.origin}/api/tasks/task-1/expanded`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ expanded: true });
  });

  it("sends expanded:false on collapse", async () => {
    const fetchMock = mockFetch();
    await api.setTaskExpanded("task-1", false);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ expanded: false });
  });
});
