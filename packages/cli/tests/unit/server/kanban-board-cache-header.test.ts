/**
 * The board HTML must carry `Cache-Control: no-store` — and ONLY the board
 * HTML. The kanban client bundle is inlined into that response at process
 * start, so a browser re-serving its cached copy would keep the old bundle
 * even after the board process was restarted.
 *
 * Boots the real offline server (same boot path as task-read-state-routes)
 * so the assertion covers the actual Express handler.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig } from "../../../src/core/config.js";

import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

describe("board HTML cache header", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "kanban-cache-header-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      // @internal test hooks — force OFFLINE mode so /kanban serves HTML
      _testToken: null,
      _testWorkspace: null,
    });
  });

  afterEach(async () => {
    await instance.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves /kanban with Cache-Control: no-store", async () => {
    const res = await fetch(`${instance.url}/kanban`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await res.text();
  });

  it("does not add no-store to non-board responses", async () => {
    const res = await fetch(`${instance.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control") ?? "").not.toContain("no-store");
    await res.text();
  });
});
