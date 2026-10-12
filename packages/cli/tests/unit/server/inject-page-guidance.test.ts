/**
 * The local /inject page must never recommend a Chrome extension — none
 * exists (no extension directory, no manifest, no install link), so that
 * advice is a dead end. Instead the CSP note must point at the options that
 * actually work: allowlisting this server's origin in the page's own
 * `script-src` + `connect-src` (build-time change, no unsafe-eval needed),
 * or the bookmarklet/console snippets where the page's CSP permits them.
 *
 * Boots the real offline server (same boot path as
 * kanban-board-cache-header) so the assertion covers the actual served HTML,
 * plus the proxy-mode refusal text in serve().
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

describe("/inject guidance text", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "inject-guidance-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    // Bounded retry-bind (same rationale as kanban-board-cache-header).
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        instance = await serve(undefined, {
          port: await getFreePort(),
          open: false,
          projectDir: tempDir,
          // @internal test hooks — force OFFLINE mode so /inject serves
          // the local (non-SaaS) variant with the CSP note.
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

  it("serves the local /inject page", async () => {
    const res = await fetch(`${instance.url}/inject`);
    expect(res.status).toBe(200);
    await res.text();
  });

  it("never recommends a Chrome extension", async () => {
    const html = await (await fetch(`${instance.url}/inject`)).text();
    expect(html).not.toMatch(/chrome extension/i);
    expect(html).not.toContain("main world");
  });

  it("points strict-CSP pages at a script-src + connect-src allowlist", async () => {
    const html = await (await fetch(`${instance.url}/inject`)).text();
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("script-src");
    expect(html).toContain("connect-src");
    expect(html).toContain("unsafe-eval");
  });

  it("proxy-mode refusal names only methods that exist", async () => {
    await expect(
      serve("http://example.com/app", {
        port: await getFreePort(),
        open: false,
        projectDir: tempDir,
      }),
    ).rejects.toThrow(/no longer supported/);
    try {
      await serve("http://example.com/app", {
        port: await getFreePort(),
        open: false,
        projectDir: tempDir,
      });
      expect.unreachable("serve() with an http target must throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toMatch(/chrome extension/i);
      expect(message).toContain("/inject");
    }
  });
});
