/**
 * Online-mode cloud cutover for the board server's SaaS-proxy routes.
 *
 * The cloud legacy surface (`/api/cli/*`, `/api/tasks/*`) is deleted, so the
 * CLI server's cloud-facing calls must hit `/api/v0` (via `surfacePath`
 * in `"cloud"` mode). The local board routes served by this same server
 * (`/api/tasks/*`) stay byte-for-byte untouched — these tests only cover the
 * three cloud calls: boards list, task import loop, and profile fetch.
 *
 * Boots the real offline server (same boot path as root-page.test.ts) with a
 * stubbed token, then stubs the cloud `fetch` boundary: local HTTP goes to
 * the real server, cloud-base HTTP gets canned responses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig } from "../../../src/core/config.js";
import { serveWithPort } from "../../helpers/serve-with-port.js";

vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
  writeToken: vi.fn(),
}));

import * as tokenModule from "../../../src/auth/token.js";

import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

const CLOUD = "http://cloud.test";

function createTaskFile(projectDir: string, task: Record<string, unknown>): void {
  const dir = join(projectDir, ".vibeflow", "tasks", "2025-01-01");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task));
}

describe("server SaaS-proxy routes hit /api/v0 (never deleted legacy)", () => {
  let tempDir: string;
  let instance: ServeInstance;
  let cloudCalls: Array<{ url: string; init?: RequestInit }>;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    tempDir = mkdtempSync(join(tmpdir(), "push-online-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    process.env.VIBEFLOW_API_URL = CLOUD;
    // Read once at kanban-route registration — must precede serve().
    process.env.VIBEFLOW_ADMIN_EMAIL = "admin@example.com";

    cloudCalls = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith(CLOUD)) {
        cloudCalls.push({ url: String(url), init });
        const u = String(url);
        if (u.includes("/api/v0/boards")) {
          return new Response(
            JSON.stringify({ workspaces: [{ id: "ws-1", name: "B" }] }),
            { status: 200 },
          );
        }
        if (u.includes("/api/v0/me")) {
          return new Response(
            JSON.stringify({ email: "admin@example.com" }),
            { status: 200 },
          );
        }
        if (u.includes("/api/v0/tasks")) {
          return new Response(
            JSON.stringify({ id: "remote-1" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "unexpected" }), {
          status: 500,
        });
      }
      return realFetch(url as string, init);
    });

    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      quiet: true,
      // @internal test hooks — force OFFLINE mode so the proxy routes
      // (registered only offline) are reachable.
      _testToken: null,
      _testWorkspace: null,
    });
  });

  afterEach(async () => {
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.VIBEFLOW_API_URL;
    delete process.env.VIBEFLOW_ADMIN_EMAIL;
  });

  it("GET /api/push/workspaces proxies to /api/v0/boards", async () => {
    const res = await realFetch(`${instance.url}/api/push/workspaces`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaces: [{ id: "ws-1", name: "B" }],
    });

    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0]!.url).toBe(`${CLOUD}/api/v0/boards`);
    expect(cloudCalls[0]!.url).not.toContain("/api/cli/");
    expect(cloudCalls[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
  });

  it("POST /api/push loops POST /api/v0/tasks (no batch import)", async () => {
    createTaskFile(tempDir, {
      id: "task-a",
      title: "A",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });
    createTaskFile(tempDir, {
      id: "task-b",
      title: "B",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const res = await realFetch(`${instance.url}/api/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keepLocalFiles: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 2, skipped: 0 });

    expect(cloudCalls).toHaveLength(2);
    for (const call of cloudCalls) {
      expect(call.url).toBe(`${CLOUD}/api/v0/tasks`);
    }
    expect(
      cloudCalls.some((c) => c.url.includes("/api/cli/import")),
    ).toBe(false);
  });

  it("GET /kanban fetches the admin profile from /api/v0/me", async () => {
    const res = await realFetch(`${instance.url}/kanban`);
    expect(res.status).toBe(200);

    const profileCall = cloudCalls.find((c) => c.url.includes("/api/v0/me"));
    expect(profileCall).toBeDefined();
    expect(profileCall!.init?.headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
    expect(
      cloudCalls.some((c) => c.url.includes("/api/cli/profile")),
    ).toBe(false);
  });
});
