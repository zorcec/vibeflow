/**
 * MCP e2e — auth (spec §2.6).
 *
 * Facts (src/mcp/auth.ts): per-request readAuthToken() reads
 * $HOME/.vibeflow/auth.json {"token": <string>}; no token ⇒ loopback-only
 * (req.ip ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}); token configured ⇒ Bearer
 * required: missing → 401, wrong → 403, valid → next(). SHA-256 +
 * timingSafeEqual comparison. Express has NO `trust proxy` ⇒ X-Forwarded-For
 * forging is ignored.
 *
 * Boot: SPAWNED server (spawnApiServer) with HOME-isolated env so auth state
 * lives in tmpHome/.vibeflow/. Never boot auth tests without HOME isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { networkInterfaces } from "node:os";
import {
  getFreePort,
  spawnApiServer,
  PROTOCOL_VERSION,
} from "./mcp-helpers.js";
import type { ChildProcess } from "node:child_process";

/** First non-internal IPv4 on any interface (mirrors server.ts getLanIp). */
function getLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

/**
 * Raw MCP fetch with a host allowlist: loopback always allowed; RFC1918
 * private LAN addresses allowed (needed for the 0.0.0.0-bind auth tests).
 * Everything else is rejected — no outbound requests to arbitrary hosts.
 */
function isAllowedHost(hostname: string): boolean {
  if (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost")
    return true;
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

async function rawFetch(
  url: string,
  opts: { headers?: Record<string, string>; body?: string },
): Promise<Response> {
  const parsed = new URL(url);
  if (!isAllowedHost(parsed.hostname)) {
    throw new Error(`Host not allowlisted: ${parsed.hostname}`);
  }
  return fetch(parsed, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(opts.headers ?? {}),
    },
    body: opts.body,
  });
}

function jsonRpcInit(id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-e2e-client", version: "0.0.0" },
    },
  });
}

describe("MCP auth", () => {
  let tmpHome: string;
  let tmpProject: string;
  let child: ChildProcess | null = null;
  let port: number;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mcp-auth-home-"));
    tmpProject = mkdtempSync(join(tmpdir(), "mcp-auth-proj-"));
  });

  afterEach(() => {
    child?.kill("SIGKILL");
    child = null;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  async function boot(opts: { host?: string } = {}) {
    // getFreePort + spawn has a TOCTOU window; under concurrent forks another
    // file can claim the port between probe and bind (server exits 1).
    // Retry with a fresh port — bounded, so genuine failures still surface.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        port = await getFreePort();
        const spawned = spawnApiServer({
          cwd: tmpProject,
          home: tmpHome,
          port,
          host: opts.host,
        });
        child = spawned.child;
        await spawned.waitReady;
        return spawned;
      } catch (err) {
        lastErr = err;
        child?.kill("SIGKILL");
        child = null;
      }
    }
    throw lastErr;
  }

  it("1: loopback without token → 200 + session id header", async () => {
    await boot();
    const res = await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      body: jsonRpcInit(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("2: full handshake + tools/list without token (loopback)", async () => {
    await boot();
    const init = await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      body: jsonRpcInit(),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      headers: { "mcp-session-id": sid },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    const list = await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      headers: { "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.result.tools.length).toBe(10);
  });

  it("3: non-loopback without token → 401", async () => {
    const lan = getLanIp();
    if (!lan) {
      console.log("SKIP: no LAN IPv4 available");
      return;
    }
    await boot({ host: "0.0.0.0" });
    const res = await rawFetch(`http://${lan}:${port}/api/mcp`, {
      body: jsonRpcInit(),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(body.message).toContain("non-loopback");
  });

  it("4: X-Forwarded-For does not spoof loopback", async () => {
    const lan = getLanIp();
    if (!lan) {
      console.log("SKIP: no LAN IPv4 available");
      return;
    }
    await boot({ host: "0.0.0.0" });
    const res = await rawFetch(`http://${lan}:${port}/api/mcp`, {
      headers: { "X-Forwarded-For": "127.0.0.1" },
      body: jsonRpcInit(),
    });
    // Express has no trust proxy configured — req.ip is the socket address
    expect(res.status).toBe(401);
  });

  it("5: token configured, no Bearer → 401", async () => {
    mkdirSync(join(tmpHome, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".vibeflow", "auth.json"),
      JSON.stringify({ token: "s3cr3t-e2e" }),
    );
    await boot();
    const res = await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      body: jsonRpcInit(),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe("Missing or invalid Authorization header");
  });

  it("6: token configured, wrong Bearer → 403", async () => {
    mkdirSync(join(tmpHome, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".vibeflow", "auth.json"),
      JSON.stringify({ token: "s3cr3t-e2e" }),
    );
    await boot();
    const res = await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      headers: { Authorization: "Bearer wrong-value" },
      body: jsonRpcInit(),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
    expect(body.message).toBe("Invalid authentication token");
  });

  it("7: token configured, valid Bearer → 200 + tools/list", async () => {
    mkdirSync(join(tmpHome, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".vibeflow", "auth.json"),
      JSON.stringify({ token: "s3cr3t-e2e" }),
    );
    await boot();
    const init = await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      headers: { Authorization: "Bearer s3cr3t-e2e" },
      body: jsonRpcInit(),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      headers: {
        "mcp-session-id": sid,
        Authorization: "Bearer s3cr3t-e2e",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    const list = await rawFetch(`http://127.0.0.1:${port}/api/mcp`, {
      headers: { "mcp-session-id": sid, Authorization: "Bearer s3cr3t-e2e" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.result.tools.length).toBe(10);
  });

  it.skip(
    "8: token compare robustness (control/diff length) — timing measured only if CI allows",
    async () => {
      // Optional per spec §2.6 #8 — skipped by default.
    },
  );
});
