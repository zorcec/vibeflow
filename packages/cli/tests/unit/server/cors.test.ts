/**
 * CORS tests for the local task API server (useCors in src/server/server.ts).
 *
 * Boots the real API-only server in offline mode (same boot path the kanban
 * board uses), so the assertions cover the actual Express middleware rather
 * than a copy of it. The overlay is injected into pages on any host
 * (localhost, LAN IP, remote https), so the server must reflect any request
 * Origin instead of gating on localhost.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig } from "../../../src/core/config.js";

import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

const REMOTE_ORIGIN = "https://stage.example.test";

describe("CORS (useCors)", () => {
  let tempDir: string;
  let instance: ServeInstance;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-cors-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    instance = await serveWithPort(undefined, {
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
  });

  it("preflight OPTIONS from a non-localhost origin echoes it with PNA + overlay headers", async () => {
    const res = await fetch(`${instance.url}/api/tasks`, {
      method: "OPTIONS",
      headers: {
        Origin: REMOTE_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, X-Overlay-Api-Key",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(REMOTE_ORIGIN);
    expect(res.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    const allowHeaders =
      res.headers.get("access-control-allow-headers") ?? "";
    expect(allowHeaders.toLowerCase()).toContain("content-type");
    expect(allowHeaders.toLowerCase()).toContain("x-overlay-api-key");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("simple request from a localhost origin echoes it (unchanged behavior)", async () => {
    const res = await fetch(`${instance.url}/api/pages`, {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
  });

  it("request with no Origin header gets ACAO *", async () => {
    const res = await fetch(`${instance.url}/api/pages`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("POST /api/tasks cross-origin (preflight then actual) is allowed", async () => {
    const preflight = await fetch(`${instance.url}/api/tasks`, {
      method: "OPTIONS",
      headers: {
        Origin: REMOTE_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      REMOTE_ORIGIN,
    );

    const actual = await fetch(`${instance.url}/api/tasks`, {
      method: "POST",
      headers: {
        Origin: REMOTE_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "CORS task",
        description: "",
        selector: "#cors-btn",
        url: `${REMOTE_ORIGIN}/page`,
      }),
    });
    expect(actual.status).toBe(200);
    expect(actual.headers.get("access-control-allow-origin")).toBe(
      REMOTE_ORIGIN,
    );
    const body = (await actual.json()) as { task?: { title?: string } };
    expect(body.task?.title).toBe("CORS task");
  });

  it("GET /api/pages cross-origin from a non-localhost origin is allowed", async () => {
    const res = await fetch(`${instance.url}/api/pages`, {
      headers: { Origin: REMOTE_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(REMOTE_ORIGIN);
  });
});
