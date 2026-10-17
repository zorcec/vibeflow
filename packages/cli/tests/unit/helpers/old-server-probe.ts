/**
 * Shared old-server fetch router for push-path unit tests (ticket 8d3b2b81).
 *
 * `push()` probes `GET /api/v0/tasks/batch` before creating anything.
 * Tests pinning the LEGACY one-by-one loop answer the probe with 404 (old
 * server) while delegating every other call to the inner mock — so
 * assertions on the inner mock (counts, bodies, order, rendered lines)
 * stay exactly as they were, proving the fallback path is byte-identical.
 * Batch-path behavior lives in
 * tests/unit/saas/batch-push-8d3b2b81.test.ts (scripted statuses) and the
 * "push — batch path" block in tests/unit/commands/push.test.ts.
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
      String(url).endsWith("/api/v0/tasks/batch") &&
      (init?.method ?? "GET") === "GET"
    ) {
      return Promise.resolve(oldServerProbe404());
    }
    return callInner(url, init);
  });
}
