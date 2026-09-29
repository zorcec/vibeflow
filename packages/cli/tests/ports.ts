/**
 * Ephemeral port allocation shared by the e2e and Playwright suites.
 *
 * Its own module (rather than an export of tests/e2e/mcp-helpers.ts) so the
 * Playwright suite can import it without pulling that module's side effects —
 * telemetry suppression plus the top-level server/MCP imports. tests/e2e/
 * mcp-helpers.ts re-exports it, so existing e2e imports are unchanged.
 */
import { createServer } from "node:net";

/**
 * Ask the OS for an unused loopback port.
 *
 * The probe-then-bind window is real under a 4–8 fork pool: another file can
 * claim the port between the probe and the bind. Callers that bind the result
 * must be prepared to retry (see bootWithRetry in the specs).
 */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
