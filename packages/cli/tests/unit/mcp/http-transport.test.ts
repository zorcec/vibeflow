/**
 * MCP HTTP transport lifecycle (src/mcp/http.ts): session create → use →
 * close, plus the CORS preflight and session-id validation branches.
 *
 * mountMcp is real Express middleware over the real MCP SDK transport, so
 * these tests drive actual HTTP against an ephemeral loopback listener:
 * a broken session table, CORS regression, or auth bypass fails them.
 * Loopback requests pass mcpAuth (no token configured in hermetic HOME).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mountMcp,
  stopMcpForTests,
  getSessionCount,
  clearSessions,
} from "../../../src/mcp/http.js";

let baseUrl = "";
let server: Server | undefined;
let previousHome: string | undefined;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  process.env.VIBEFLOW_TELEMETRY = "0";
  previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "mcp-http-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  const app = express();
  app.use(express.json());
  const store = mkdtempSync(join(tmpdir(), "mcp-http-store-"));
  cleanups.push(() => rmSync(store, { recursive: true, force: true }));
  mountMcp(app, store, "local");
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  // Sessions are per-test state: clear the table between tests without
  // tearing down the server or the hermetic HOME (both live until
  // afterAll). clearSessions is the table reset; stopMcpForTests also
  // disposes the reaper interval, so it runs once at the end.
  clearSessions();
});

afterAll(async () => {
  stopMcpForTests();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  for (const fn of cleanups.splice(0)) fn();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "unit-test", version: "0" },
  },
};

const INIT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("MCP HTTP transport (mountMcp)", () => {
  it("OPTIONS preflight is answered with the MCP CORS headers", async () => {
    const r = await fetch(`${baseUrl}/api/mcp`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toContain("DELETE");
    expect(r.headers.get("access-control-allow-headers")).toContain(
      "mcp-session-id",
    );
  });

  it("GET without a session id is refused", async () => {
    const r = await fetch(`${baseUrl}/api/mcp`, { headers: { Accept: "text/event-stream" } });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "Session ID required for GET" });
  });

  it("GET with an unknown session id is a 404", async () => {
    const r = await fetch(`${baseUrl}/api/mcp`, {
      headers: { Accept: "text/event-stream", "mcp-session-id": "nope" },
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "Session not found" });
  });

  it("POST with an unknown session id is a 404", async () => {
    const r = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: { ...INIT_HEADERS, "mcp-session-id": "nope" },
      body: JSON.stringify(INIT_BODY),
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "Session not found" });
  });

  it("DELETE without a session id is refused, unknown id closes as ok", async () => {
    const missing = await fetch(`${baseUrl}/api/mcp`, { method: "DELETE" });
    expect(missing.status).toBe(400);
    const unknown = await fetch(`${baseUrl}/api/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": "nope" },
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ ok: true });
  });

  it("initialize creates a session; DELETE closes it and GET 404s after", async () => {
    const init = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: INIT_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    // A session was registered server-side.
    expect(typeof sessionId).toBe("string");
    expect((sessionId ?? "").length).toBeGreaterThan(0);
    expect(getSessionCount()).toBe(1);
    expect(await init.json()).toMatchObject({ jsonrpc: "2.0" });

    const del = await fetch(`${baseUrl}/api/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ ok: true });
    expect(getSessionCount()).toBe(0);

    const gone = await fetch(`${baseUrl}/api/mcp`, {
      headers: { Accept: "text/event-stream", "mcp-session-id": sessionId! },
    });
    expect(gone.status).toBe(404);
  });

  it("POST to an existing session is routed to its transport", async () => {
    const init = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: INIT_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect((sessionId ?? "").length).toBeGreaterThan(0);
    // The session survives its first request: a tools/list call on the
    // same id is handled by the same transport, not re-initialized.
    const list = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST",
      headers: { ...INIT_HEADERS, "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(list.status).toBe(200);
    const payload = (await list.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (payload.result?.tools ?? []).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("get_task");
    expect(getSessionCount()).toBe(1);
  });
});
