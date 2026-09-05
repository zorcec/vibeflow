/**
 * Playwright e2e tests for B4 (overlay add-task advanced section).
 *
 * The full OverlayAddModal is programmatic-only (no UI trigger in the
 * bundle), so this spec covers the wire contract the modal relies on:
 *  - the built overlay bundle ships the Advanced UI (post-build smoke)
 *  - POST /api/tasks accepts priority + tags exactly as the modal sends them
 *    and the created task JSON carries them back
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3933;
const BASE = `http://localhost:${PORT}`;

describe("Batch B — overlay advanced payload contract", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-overlayadv-pw-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
  });

  afterAll(async () => {
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("built overlay bundle ships the Advanced section", async () => {
    const res = await fetch(`${BASE}/vibeflow-overlay.js`);
    expect(res.ok).toBe(true);
    const script = await res.text();
    expect(script).toContain("Advanced");
    expect(script).toContain("Priority");
  });

  it("POST /api/tasks carries modal priority + tags onto the task", async () => {
    // Exact payload shape OverlayAddModal sends when Advanced is filled in
    const res = await fetch(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Advanced payload task",
        description: "Advanced payload task",
        selector: "/",
        status: "todo",
        priority: "High",
        tags: ["ui", "p1"],
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      task?: { priority?: string; tags?: string[] };
    };
    expect(body.task?.priority).toBe("High");
    expect(body.task?.tags).toEqual(["ui", "p1"]);
  });

  it("omitted priority/tags leave the task unadorned", async () => {
    const res = await fetch(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Plain modal task",
        description: "Plain modal task",
        selector: "/",
        status: "todo",
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      task?: { priority?: string; tags?: string[] };
    };
    // Server default applies when the modal sends no priority
    expect(body.task?.priority).toBe("Medium");
    expect(body.task?.tags ?? []).toEqual([]);
  });
});
