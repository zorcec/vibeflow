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
) {
  const callInner = inner as unknown as (
    url: unknown,
    init?: { method?: string },
  ) => unknown;
  return vi.fn((url: unknown, init?: { method?: string }) => {
    if (
      String(url).endsWith("/api/v0/tasks/import") &&
      (init?.method ?? "GET") === "GET"
    ) {
      return Promise.resolve(oldServerProbe404());
    }
    return callInner(url, init);
  });
}
