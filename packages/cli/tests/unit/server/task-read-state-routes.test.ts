/**
 * Route-level tests for the per-user kanban read state:
 * POST /api/tasks/:id/opened and POST /api/tasks/:id/expanded.
 *
 * Boots the real API-only server in offline mode (same boot path the kanban
 * board uses), so the assertions cover the actual Express handlers rather
 * than a copy of them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import {
  createTask,
  findTaskFilePath,
  getCurrentUserId,
  readTaskFile,
} from "../../../src/core/tasks.js";
import { writeConfig } from "../../../src/core/config.js";

const { serve } = await import("../../../src/server/server.js");
type ServeInstance = Awaited<ReturnType<typeof serve>>;

process.env.VIBEFLOW_TELEMETRY = "0";

/** Valid task-id shape (30 hex chars) that no task uses. */
const UNKNOWN_TASK_ID = "0".repeat(30);

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

describe("per-user read state routes", () => {
  let tempDir: string;
  let instance: ServeInstance;
  const originalUser = process.env.USER;

  beforeEach(async () => {
    // Deterministic writer id — the routes must read USER, not a constant.
    process.env.USER = "kanban-test-user";
    tempDir = mkdtempSync(join(tmpdir(), "proto-read-state-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    const port = await getFreePort();
    instance = await serve(undefined, {
      port,
      open: false,
      projectDir: tempDir,
      // @internal test hooks — force OFFLINE mode so local task routes mount
      _testToken: null,
      _testWorkspace: null,
    });
  });

  afterEach(async () => {
    await instance.close();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
  });

  function makeCard(title = "Card") {
    return createTask(tempDir, {
      title,
      description: "",
      status: "todo",
      selector: "/",
    });
  }

  function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${instance.url}${path}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  }

  it("POST /opened records the current user in openedBy", async () => {
    const task = makeCard();
    const res = await post(`/api/tasks/${task.id}/opened`);
    expect(res.status).toBe(200);
    const persisted = readTaskFile(findTaskFilePath(tempDir, task.id)!);
    expect(persisted?.openedBy).toEqual(["kanban-test-user"]);
  });

  it("POST /opened returns 404 for an unknown task", async () => {
    const res = await post(`/api/tasks/${UNKNOWN_TASK_ID}/opened`);
    expect(res.status).toBe(404);
  });

  it("POST /expanded=true adds the current user and persists it", async () => {
    const task = makeCard();
    const res = await post(`/api/tasks/${task.id}/expanded`, {
      expanded: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task?: { expandedBy?: string[] } };
    expect(body.task?.expandedBy).toEqual(["kanban-test-user"]);
    const persisted = readTaskFile(findTaskFilePath(tempDir, task.id)!);
    expect(persisted?.expandedBy).toEqual(["kanban-test-user"]);
  });

  it("POST /expanded=false removes the current user again", async () => {
    const task = makeCard();
    await post(`/api/tasks/${task.id}/expanded`, { expanded: true });
    const res = await post(`/api/tasks/${task.id}/expanded`, {
      expanded: false,
    });
    expect(res.status).toBe(200);
    const persisted = readTaskFile(findTaskFilePath(tempDir, task.id)!);
    expect(persisted?.expandedBy).toEqual([]);
  });

  it("treats a missing/false expanded flag as collapse", async () => {
    const task = makeCard();
    await post(`/api/tasks/${task.id}/expanded`, { expanded: true });
    await post(`/api/tasks/${task.id}/expanded`, {});
    const persisted = readTaskFile(findTaskFilePath(tempDir, task.id)!);
    expect(persisted?.expandedBy).toEqual([]);
  });

  it("POST /expanded returns 404 for an unknown task", async () => {
    const res = await post(`/api/tasks/${UNKNOWN_TASK_ID}/expanded`, {
      expanded: true,
    });
    expect(res.status).toBe(404);
  });

  it("GET /kanban injects the current user id for the board shell", async () => {
    const html = await fetch(`${instance.url}/kanban`).then((r) => r.text());
    expect(html).toContain('window.__VIBEFLOW_USER__ = "kanban-test-user"');
    expect(getCurrentUserId()).toBe("kanban-test-user");
  });
});
