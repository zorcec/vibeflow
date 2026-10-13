/**
 * Part A stopgap for the board-server root page: exact `/` → `/kanban` (302).
 *
 * Today the kanban (API-only) server registers `/kanban`, `/inject`, `/api/*`
 * but no root, so `GET /` is Express's default 404. This asserts the stopgap
 * redirect — status, Location, fragment behaviour, and that no other route
 * is shadowed. (Part B replaces this redirect with the server-rendered
 * morning-briefing home; the history of this file records the stopgap.)
 *
 * Boots the real offline server (same boot path as kanban-board-cache-header)
 * so the assertions cover the actual Express handler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { writeConfig } from "../../../src/core/config.js";

const { serve } = await import("../../../src/server/server.js");
type ServeInstance = Awaited<ReturnType<typeof serve>>;

process.env.VIBEFLOW_TELEMETRY = "0";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

describe("board-server root stopgap redirect", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "root-redirect-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    // Bounded retry-bind (same rationale as kanban-board-cache-header;
    // five attempts: under the full-suite thread pool several server-booting
    // files race for ports and three can exhaust).
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        instance = await serve(undefined, {
          port: await getFreePort(),
          open: false,
          projectDir: tempDir,
          // @internal test hooks — force OFFLINE mode.
          _testToken: null,
          _testWorkspace: null,
        });
        return;
      } catch (err) {
        lastErr = err;
        if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw err;
      }
    }
    throw lastErr;
  });

  afterEach(async () => {
    await instance.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("redirects exact / to /kanban with a 302", async () => {
    const res = await fetch(`${instance.url}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/kanban");
    await res.text();
  });

  it("keeps the Location fragment-free so browsers preserve #task-<id>", async () => {
    // fetch() never sends the fragment to the server; what matters is that
    // the Location carries none of its own, so the browser re-attaches the
    // original `#task-<id>` across the redirect and board deep links work.
    const res = await fetch(`${instance.url}/`, { redirect: "manual" });
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("#");
    await res.text();
  });

  it("does not shadow any other route", async () => {
    for (const path of ["/kanban", "/inject", "/api/health"]) {
      const res = await fetch(`${instance.url}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(200);
      await res.text();
    }
  });
});
