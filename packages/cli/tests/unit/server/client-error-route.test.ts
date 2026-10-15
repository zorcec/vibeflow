/**
 * CLI error reporting through the REAL server (ticket 5087f5e3 flag test).
 *
 * Boots the API-only server (same boot path the kanban board uses) with the
 * telemetry `capture()` seam mocked, then drives the three error ingress
 * points with telemetry DISABLED (each must produce ZERO transport calls)
 * and ENABLED (each exactly ONE `cli_error` event tagged environment=cli
 * with a scrubbed message):
 *   1. injected client error → POST /api/client-error
 *   2. thrown server route → malformed JSON (express.json throws into the
 *      error middleware; response behavior pinned unchanged at 500)
 * The unhandled-rejection ingress is covered at its handler seam in
 * cli-error-scrub.test.ts — a rejection cannot be safely raised against a
 * shared in-process server.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig } from "../../../src/core/config.js";
import { serveWithPort } from "../../helpers/serve-with-port.js";
import type { ServeInstance } from "../../../src/server/server.js";
import { resetCliErrorReportState } from "../../../src/server/cli-error-report.js";

/** Spy shared with the hoisted `vi.mock` factory below. */
const captureSpy = vi.hoisted(() => vi.fn());

vi.mock("../../../src/telemetry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/telemetry.js")>();
  return {
    ...actual,
    capture: captureSpy,
  };
});

let tempDir = "";
let instance: ServeInstance;
let base = "";

const REALISTIC_CLIENT_BODY = {
  name: "TypeError",
  message: `Cannot read properties of undefined while rendering task "Frontend cache (online product)" from /home/operator/projects/acme/.vibeflow/tasks/302e9cab6422a086e1c9c338c1f889.json`,
  url: "http://127.0.0.1/kanban#task-302e9cab6422a086e1c9c338c1f889",
};

function enableTelemetry(): void {
  delete process.env.VIBEFLOW_TELEMETRY;
  process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS = "1";
}

function disableTelemetry(): void {
  delete process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS;
  process.env.VIBEFLOW_TELEMETRY = "0";
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "cli-err-route-"));
  writeConfig(tempDir, { mode: "attach", port: 3700 });
  instance = await serveWithPort(undefined, {
    open: false,
    projectDir: tempDir,
    _testToken: null,
    _testWorkspace: null,
  });
  base = instance.url;
});

afterAll(async () => {
  await instance?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  disableTelemetry();
});

async function postClientError(): Promise<Response> {
  return fetch(`${base}/api/client-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(REALISTIC_CLIENT_BODY),
  });
}

async function throwServerRoute(): Promise<Response> {
  // Malformed JSON: express.json throws synchronously into the error
  // middleware — the closest a test can get to a thrown route handler
  // without adding a test-only route to the production server.
  return fetch(`${base}/api/tasks/abcdef1234567890abcdef123456`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: "{malformed json",
  });
}

describe("client-error ingress through the real server", () => {
  it("DISABLED: injected client error + thrown route → 204/500, ZERO transport calls", async () => {
    disableTelemetry();
    captureSpy.mockClear();
    resetCliErrorReportState();

    const clientRes = await postClientError();
    expect(clientRes.status).toBe(204);

    const routeRes = await throwServerRoute();
    expect(routeRes.status).toBe(500);
    expect(await routeRes.json()).toEqual({ error: "Internal server error" });

    expect(captureSpy).toHaveBeenCalledTimes(0);
  });

  it("ENABLED: each ingress → exactly ONE environment=cli event with a scrubbed message", async () => {
    enableTelemetry();
    captureSpy.mockClear();
    resetCliErrorReportState();

    const clientRes = await postClientError();
    expect(clientRes.status).toBe(204);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [clientEvent, clientProps] = captureSpy.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(clientEvent).toBe("cli_error");
    expect(clientProps).toMatchObject({ environment: "cli", source: "client" });
    const clientMessage = String(clientProps.error_message);
    expect(clientMessage).not.toContain("Frontend cache (online product)");
    expect(clientMessage).not.toContain("/home/operator/");
    expect(clientMessage).not.toContain("302e9cab6422a086e1c9c338c1f889");
    // Deep-link fragment never leaves the machine either.
    expect(String(clientProps.route ?? "")).not.toContain("#task-");
    console.log(`[cli_error payload] ${JSON.stringify({ clientEvent, clientProps })}`);

    const routeRes = await throwServerRoute();
    expect(routeRes.status).toBe(500);
    expect(captureSpy).toHaveBeenCalledTimes(2);
    const [routeEvent, routeProps] = captureSpy.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
    expect(routeEvent).toBe("cli_error");
    expect(routeProps).toMatchObject({
      environment: "cli",
      source: "server",
      status_code: 500,
    });
    expect(String(routeProps.route ?? "")).toContain("/api/tasks/");
  });
});
