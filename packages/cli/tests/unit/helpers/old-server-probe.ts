/**
 * Shared old-server fetch router for push-path unit tests (ticket 8d3b2b81).
 *
 * `push()` probes `GET /api/v0/tasks/import` before creating anything.
 * Tests pinning the LEGACY one-by-one loop answer the probe with 404 (old
 * server) while delegating every other call to the inner mock — so
 * assertions on the inner mock (counts, bodies, order, rendered lines)
 * stay exactly as they were, proving the fallback path is byte-identical.
 * Tree-import behavior lives in
 * tests/unit/saas/batch-import-bulk-429.test.ts (scripted statuses) and
 * tests/e2e/batch-push.test.ts (mock contract server).
 */
import { vi } from "vitest";

export function oldServerProbe404() {
  return {
    ok: false,
    status: 404,
    statusText: "Not Found",
    json: () => Promise.resolve({ error: "not found" }),
  };
}

export function withOldServerProbe(
  inner: (...args: never[]) => unknown,
  opts?: { listItems?: Array<Record<string, unknown>>; listStatus?: number },
) {
  const callInner = inner as unknown as (
    url: unknown,
    init?: { method?: string },
  ) => unknown;
  return vi.fn((url: unknown, init?: { method?: string }) => {
    // Match the PATH, not the whole URL: the probe appends `?boardId=` when a
    // board is selected (multi-board accounts), and a strict endsWith sent the
    // probe to the inner mock instead of this router.
    if (
      String(url).includes("/api/v0/tasks/import") &&
      (init?.method ?? "GET") === "GET"
    ) {
      return Promise.resolve(oldServerProbe404());
    }
    // Diff-based push: push() fetches online ids FIRST (GET
    // /api/v0/tasks?boardId=…&limit=100). Old-server tests answer with an
    // empty board by default (every local task unsynced — legacy count
    // assertions shift by exactly this one call); pass `listItems` to pin
    // a non-empty board (already-synced tasks are never POSTed).
    if (
      String(url).includes("/api/v0/tasks?") &&
      (init?.method ?? "GET") === "GET"
    ) {
      const items = opts?.listItems ?? [];
      const status = opts?.listStatus ?? 200;
      if (status !== 200) {
        // Board-scope rejection (deleted board / wrong account): the push
        // must refuse before the first write, never fall back to "push all".
        return Promise.resolve({
          ok: false,
          status,
          statusText: status === 403 ? "Forbidden" : "Unauthorized",
          json: () => Promise.resolve({ error: "Board not found or access denied", code: "FORBIDDEN" }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items, nextCursor: null }),
      });
    }
    return callInner(url, init);
  });
}
