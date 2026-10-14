/**
 * A refused `serve()` start must leave no listener behind.
 *
 * Context: `serve()` builds its Express app, WebSocket server, MCP mount,
 * and file watchers BEFORE `httpServer.listen()` runs, so a port collision
 * (EADDRINUSE) used to reject while leaving all of that behind. These tests
 * pin the fix: after a failed start the port is bindable again, and a later
 * boot still serves.
 *
 * Race note: releasing the squatted port returns it to the shared ephemeral
 * pool, where a sibling worker may briefly claim it under full-suite load.
 * The bindability probe therefore retries — but a leak from OUR OWN failed
 * start would fail deterministically forever (it never goes away), so a
 * bounded probe still proves the property.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { serve } from "../../../src/server/server.js";
import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

/** Occupy a port with a plain non-Vibeflow socket; returns it + release. */
async function squat(): Promise<{
  port: number;
  release: () => Promise<void>;
}> {
  const squatter = createServer();
  const port = await new Promise<number>((resolve) => {
    squatter.listen(0, "127.0.0.1", () =>
      resolve((squatter.address() as { port: number }).port),
    );
  });
  return {
    port,
    release: () => new Promise<void>((r) => squatter.close(() => r())),
  };
}

/**
 * Bind `port` with a raw socket, retrying while a sibling worker holds it.
 * Resolves once bound (proving nothing of OURS holds it), rejects when the
 * budget runs out — which is what a leaked listener from our own failed
 * start would produce, since that never goes away.
 */
async function waitForBindable(port: number): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.on("error", reject);
        probe.listen(port, "127.0.0.1", () => {
          probe.close(() => resolve());
        });
      });
      return;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw err;
      await new Promise<void>((r) => setTimeout(r, 100));
    }
  }
  throw lastErr;
}

describe("serve() refused bind leaves no listener behind", () => {
  const tempDirs: string[] = [];
  const instances: ServeInstance[] = [];

  afterEach(async () => {
    for (const i of instances.splice(0)) await i.close();
    for (const d of tempDirs.splice(0))
      rmSync(d, { recursive: true, force: true });
  });

  function freshDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("API-only: the taken port is bindable once the squatter leaves", async () => {
    const dir = freshDir("serve-cleanup-api-");
    const { port, release } = await squat();
    await expect(
      serve(undefined, {
        port,
        open: false,
        projectDir: dir,
        quiet: true,
        _testToken: null,
        _testWorkspace: null,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    await release();
    await waitForBindable(port);
    // A later boot still serves (failed start corrupted no global state).
    const instance = await serveWithPort(undefined, {
      open: false,
      projectDir: dir,
      quiet: true,
      _testToken: null,
      _testWorkspace: null,
    });
    instances.push(instance);
    const res = await fetch(`${instance.url}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("API-only: a later boot on another port still serves after a refusal", async () => {
    const dir = freshDir("serve-cleanup-next-");
    const { release } = await squat().then(async (s) => {
      await expect(
        serve(undefined, {
          port: s.port,
          open: false,
          projectDir: dir,
          quiet: true,
          _testToken: null,
          _testWorkspace: null,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      return s;
    });
    await release();
    const instance = await serveWithPort(undefined, {
      open: false,
      projectDir: dir,
      quiet: true,
      _testToken: null,
      _testWorkspace: null,
    });
    instances.push(instance);
    const res = await fetch(`${instance.url}/api/tasks`);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).tasks)).toBe(true);
  });

  it("HTML-target: the taken port is bindable once the squatter leaves", async () => {
    const dir = freshDir("serve-cleanup-html-");
    const filePath = join(dir, "index.html");
    writeFileSync(filePath, "<html><body><h1>hi</h1></body></html>", "utf-8");
    const { port, release } = await squat();
    await expect(
      serve(filePath, { port, open: false }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    await release();
    await waitForBindable(port);
    const instance = await serveWithPort(filePath, { open: false });
    instances.push(instance);
    const res = await fetch(`${instance.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hi");
  });
});
