/**
 * System-file flag at the HTTP layer:
 * POST /baseline* stores a flagged ref; POST /files/:filename (user upload)
 * stores an unflagged ref; GET /files surfaces the difference.
 *
 * Boots the real API-only server in offline mode (same boot path the kanban
 * board uses), so the assertions cover the actual Express handlers.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createTask } from "../../../src/core/tasks.js";
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

describe("system-file flag routes", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-sysroutes-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    // Bounded retry-bind: getFreePort() probes then releases, so under the
    // unit-suite thread pool (or a concurrent suite run) another worker can
    // claim the port before serve() binds it. serve() needs a pre-known port
    // (its URLs are derived from it before listen), so retry with a fresh
    // port on EADDRINUSE instead of failing the file.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        instance = await serve(undefined, {
          port: await getFreePort(),
          open: false,
          projectDir: tempDir,
          // @internal test hooks — force OFFLINE mode so local task routes mount
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

  function makeTask() {
    return createTask(tempDir, {
      title: "Route flag test",
      description: "",
      status: "todo",
      selector: "/",
    });
  }

  function makeBaseline() {
    return {
      outerHTML: '<button class="submit">Submit</button>',
      computedStyles: {},
      selector: ".submit",
      position: {
        boundingBox: { x: 0, y: 0, width: 10, height: 10 },
        scrollPosition: { x: 0, y: 0 },
        viewport: { width: 100, height: 100, dpr: 1 },
        stackingContext: { zIndex: "auto", position: "static" },
      },
      browser: "test",
      consoleErrors: [],
      capturedAt: new Date().toISOString(),
    };
  }

  async function getFiles(taskId: string) {
    const res = await fetch(`${instance.url}/api/tasks/${taskId}/files`);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      files: Array<{ name: string; system?: boolean }>;
    };
  }

  it("POST /baseline stores a flagged ref visible in GET /files", async () => {
    const task = makeTask();
    const res = await fetch(`${instance.url}/api/tasks/${task.id}/baseline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseline: makeBaseline() }),
    });
    expect(res.status).toBe(200);
    const { files } = await getFiles(task.id);
    const ref = files.find((f) => f.name === "baseline-element.json");
    expect(ref).toBeDefined();
    expect(ref!.system).toBe(true);
  });

  it("POST /baseline-page stores a flagged ref", async () => {
    const task = makeTask();
    const res = await fetch(
      `${instance.url}/api/tasks/${task.id}/baseline-page`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: {
            version: 1,
            elements: {},
            capturedAt: new Date().toISOString(),
            truncated: false,
          },
        }),
      },
    );
    expect(res.status).toBe(200);
    const { files } = await getFiles(task.id);
    const ref = files.find((f) => f.name === "baseline-page.json");
    expect(ref).toBeDefined();
    expect(ref!.system).toBe(true);
  });

  it("POST /files/:filename (user upload) stores an unflagged ref", async () => {
    const task = makeTask();
    const res = await fetch(
      `${instance.url}/api/tasks/${task.id}/files/notes.md`,
      {
        method: "POST",
        headers: { "Content-Type": "text/markdown" },
        body: "hello",
      },
    );
    expect(res.status).toBe(200);
    const { files } = await getFiles(task.id);
    const ref = files.find((f) => f.name === "notes.md");
    expect(ref).toBeDefined();
    expect(ref!.system).toBeUndefined();
    expect("system" in ref!).toBe(false);
  });
});
