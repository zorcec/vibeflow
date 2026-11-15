/**
 * Path-based task deep links serve the board HTML: the kanban bundle is a
 * single-page app that parses `/kanban/<task-id>[/<tab>]` on load and opens
 * the task on the requested tab.
 *
 * Boots the real offline server (same boot path as root-page) so the
 * assertions cover the actual Express handlers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.VIBEFLOW_TELEMETRY = "0";

const ID = "d89a3009abf34626c7f31f14ea08a0";

describe("board deep-link routes", () => {
  let tempDir: string;
  let instance: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    const { writeConfig } = await import("../../../src/core/config.js");
    const { serveWithPort } = await import("../../helpers/serve-with-port.js");
    tempDir = mkdtempSync(join(tmpdir(), "kanban-deep-link-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      // Explicit IPv4 loopback: `localhost` resolves to ::1 first in some
      // sandboxes while the test server binds IPv4 (or vice versa), which
      // makes fetch refuse a hostname URL for no product reason.
      host: "127.0.0.1",
      // @internal test hooks — force OFFLINE mode so /kanban serves HTML.
      _testToken: null,
      _testWorkspace: null,
    });
  });

  afterEach(async () => {
    await instance.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves the board for /kanban/<task-id>", async () => {
    const res = await fetch(`${instance.url}/kanban/${ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("kanban");
  });

  it("serves the board for every tab slug", async () => {
    for (const slug of ["activity", "comments", "details", "files"]) {
      const res = await fetch(`${instance.url}/kanban/${ID}/${slug}`);
      expect(res.status, slug).toBe(200);
      expect(res.headers.get("cache-control"), slug).toBe("no-store");
      await res.text();
    }
  });

  it("still serves the plain board", async () => {
    const res = await fetch(`${instance.url}/kanban`);
    expect(res.status).toBe(200);
    await res.text();
  });
});
