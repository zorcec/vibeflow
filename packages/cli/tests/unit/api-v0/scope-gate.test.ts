/**
 * Scope-gate proof for the /api/v0 read alias (P1, plan §4.3/§4.4).
 *
 * Boots the server with a scoped-down principal (via the
 * `_testResolvePrincipal` seam — the production default is the trusted
 * local principal) and asserts the gate denies per-scope: reads without
 * the grant are 403 SCOPE_DENIED, granted and public reads pass, and the
 * legacy routes are untouched by the gate.
 *
 * Non-vacuity: with the requireScope call removed from server/v0.ts these
 * 403 assertions fail (demonstrated during development — see the report).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig } from "../../../src/core/config.js";
import { createTask } from "../../../src/core/tasks.js";
import type { Principal } from "@vibeflow-tools/api-core";
import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";

process.env.VIBEFLOW_TELEMETRY = "0";

/** A user principal holding only profile:read on the local scope. */
function limitedPrincipal(): Principal {
  return {
    kind: "user",
    userId: "u-scope-gate",
    scopes: new Set(["profile:read"]),
    scope: { kind: "local" },
    tokenId: "t-scope-gate",
  };
}

describe("v0 scope gate denies per-scope, legacy untouched", () => {
  let tempDir: string;
  let instance: ServeInstance;
  let baseUrl: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-v0-gate-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    createTask(tempDir, {
      title: "P1 gate fixture",
      description: "scope-gate fixture",
      status: "todo",
      selector: "#gate-fixture",
    });
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir: tempDir,
      _testToken: null,
      _testWorkspace: null,
      _testResolvePrincipal: limitedPrincipal,
    });
    baseUrl = instance.url;
  }, 30000);

  afterAll(async () => {
    await instance?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("denies a read whose scope the principal lacks (403 SCOPE_DENIED)", async () => {
    for (const path of [
      "/api/v0/tasks",
      "/api/v0/settings",
      "/api/v0/project",
    ]) {
      const res = await fetch(baseUrl + path);
      expect(res.status, `GET ${path} must be denied`).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "Forbidden",
        code: "SCOPE_DENIED",
      });
    }
  });

  it("allows the granted scope and the public read", async () => {
    const me = await fetch(`${baseUrl}/api/v0/me`);
    expect(me.status).toBe(200);
    const changelog = await fetch(`${baseUrl}/api/v0/changelog`);
    expect(changelog.status).toBe(200);
  });

  it("leaves the legacy routes untouched (no gate there)", async () => {
    // The gate lives only on the v0 alias: the same reads on the legacy
    // paths still serve with no principal check at all.
    for (const path of ["/api/tasks", "/api/settings", "/api/project"]) {
      const res = await fetch(baseUrl + path);
      expect(res.status, `legacy GET ${path} must be un-gated`).toBe(200);
    }
  });
});
