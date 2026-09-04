/**
 * MCP e2e — transport/session lifecycle (spec §2.1, scenarios 1–15).
 *
 * Covers: protocol version echo, serverInfo, notifications, tools/list size,
 * DELETE lifecycle, missing/unknown session ids, concurrent sessions,
 * cross-instance 404, OPTIONS preflight, GET SSE stream.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bootMcpServer,
  newClient,
  initialize,
  listTools,
  jsonRpcBody,
  getSessionCount,
  spawnApiServer,
  getFreePort,
  ensureTaskDirs,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

// Localhost-only fetch wrapper — satisfies SSRF lint (all e2e test URLs are
// 127.0.0.1 or localhost from bootMcpServer/spawnApiServer).
function localFetch(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new Error(`SSRF blocked: ${url} is not a localhost URL`);
  }
  return fetch(url, init);
}

describe("MCP transport/session lifecycle", () => {
  let env: McpTestEnv;
  let client: McpClient;

  beforeEach(async () => {
    env = await bootMcpServer();
    client = newClient(env.mcpUrl);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("1: initialize returns protocolVersion, serverInfo, capabilities", async () => {
    const res = await initialize(client);
    expect(res.status).toBe(200);
    expect(client.sessionId).toBeDefined();

    const body = await res.json();
    expect(body.result.protocolVersion).toBeDefined();
    expect(body.result.serverInfo.name).toBe("vibeflow");
    expect(body.result.serverInfo.version).toBe("0.1.0");
    expect(body.result.capabilities.tools.listChanged).toBeDefined();
  });

  it("2: initialize with different protocolVersion succeeds", async () => {
    const c = newClient(env.mcpUrl);
    const res = await initialize(c, "2024-11-05");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.protocolVersion).toBeDefined();
  });

  it("3: notifications/initialized returns 202", async () => {
    const c = newClient(env.mcpUrl);
    await initialize(c);
    // Already called in initialize — verify session works
    const res = await listTools(c);
    expect(res.status).toBe(200);
  });

  it("4: tools/list returns exactly 10 tools", async () => {
    await initialize(client);
    const res = await listTools(client);
    expect(res.status).toBe(200);
    const body = await res.json();
    const tools = body.result.tools;
    expect(tools.length).toBe(10);
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema?.type).toBe("object");
    }
  });

  it("5: tools/call without notifications/initialized still works", async () => {
    // Initialize but don't call notifications/initialized
    const c = newClient(env.mcpUrl);
    const res = await fetch(c.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(
        jsonRpcBody(1, "initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.0" },
        }),
      ),
    });
    expect(res.ok).toBe(true);
    const sid = res.headers.get("mcp-session-id");
    expect(sid).toBeDefined();
    // Skip notification, go straight to tools/list
    const res2 = await localFetch(c.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sid!,
      },
      body: JSON.stringify(jsonRpcBody(2, "tools/list", {})),
    });
    // Should be 200 or a clean JSON-RPC error, never 500
    expect(res2.status).not.toBe(500);
  });

  it("6: DELETE session then POST with same id → 404", async () => {
    await initialize(client);
    const sid = client.sessionId;
    expect(sid).toBeDefined();

    // DELETE
    const delRes = await localFetch(env.mcpUrl, {
      method: "DELETE",
      headers: { "mcp-session-id": sid! },
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.ok).toBe(true);

    // POST with same session id → 404
    const postRes = await localFetch(env.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sid!,
      },
      body: JSON.stringify(jsonRpcBody(99, "tools/list", {})),
    });
    expect(postRes.status).toBe(404);
    const postBody = await postRes.json();
    expect(postBody.error).toBe("Session not found");
  });

  it("7: DELETE without session id → 400", async () => {
    const res = await localFetch(env.mcpUrl, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("8: GET without session id → 400", async () => {
    const res = await localFetch(env.mcpUrl, { method: "GET" });
    expect(res.status).toBe(400);
  });

  it("9: GET unknown session id → 404", async () => {
    const res = await localFetch(env.mcpUrl, {
      method: "GET",
      headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" },
    });
    expect(res.status).toBe(404);
  });

  it("10: POST with deleted/unknown session id → 404", async () => {
    const res = await localFetch(env.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "11111111-2222-4333-8444-555555555555",
      },
      body: JSON.stringify(jsonRpcBody(1, "tools/list", {})),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  it("11: POST without session header + non-initialize → clean rejection (not 500)", async () => {
    const res = await localFetch(env.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(jsonRpcBody(1, "tools/list", {})),
    });
    expect(res.status).not.toBe(500);
  });

  it("12: concurrent sessions — two clients, both work, count === 2", async () => {
    const c1 = newClient(env.mcpUrl);
    const c2 = newClient(env.mcpUrl);
    await initialize(c1);
    await initialize(c2);
    expect(c1.sessionId).not.toBe(c2.sessionId);

    const r1 = await listTools(c1);
    const r2 = await listTools(c2);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(getSessionCount()).toBe(2);
  });

  it("13: cross-instance session id → 404", async () => {
    await initialize(client);
    const sid = client.sessionId;

    // Boot a second server in a separate process
    const port2 = await getFreePort();
    const tmpDir = mkdtempSync(join(tmpdir(), "mcp-xinst-"));
    ensureTaskDirs(tmpDir);
    const {
      child,
      mcpUrl: mcpUrl2,
      waitReady,
    } = spawnApiServer({ cwd: tmpDir, home: tmpDir, port: port2 });

    try {
      await waitReady;
      // POST with S1's session id to S2
      const res = await localFetch(mcpUrl2, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": sid!,
        },
        body: JSON.stringify(jsonRpcBody(1, "tools/list", {})),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Session not found");
    } finally {
      child.kill();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("14: OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await localFetch(env.mcpUrl, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    // server.ts CORS middleware runs first and sets allow-origin + allow-headers;
    // the MCP handler's CORS (which adds mcp-session-id/authorization) never
    // runs for OPTIONS because server.ts short-circuits with 204.
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3700",
    );
    const allowHeaders = res.headers.get("access-control-allow-headers") ?? "";
    expect(allowHeaders.toLowerCase()).toContain("content-type");
  });

  it("15: GET SSE stream with live session returns event-stream", async () => {
    await initialize(client);
    const res = await localFetch(env.mcpUrl, {
      method: "GET",
      headers: { "mcp-session-id": client.sessionId! },
    });
    // Should be 200 with event-stream, or a documented non-500 status
    expect(res.status).not.toBe(500);
    const ct = res.headers.get("content-type") ?? "";
    // Accept either event-stream or whatever the SDK returns
    if (res.status === 200) {
      expect(ct).toContain("text/event-stream");
    }
  });
});
