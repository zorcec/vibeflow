/**
 * Anti-drift guard §6.4 #3 — one parity suite, executed twice (P1, read surface).
 *
 * The SAME assertions run against the legacy path and the /api/v1 read
 * alias: every pair must return the same status and byte-identical bodies.
 * Byte-identity is the point — the alias delegates to the ONE existing
 * handler, so any second implementation (or any behaviour change to a
 * legacy route) shows up here as a byte difference, not a judgment call.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { writeConfig } from "../../../src/core/config.js";
import { createTask } from "../../../src/core/tasks.js";
import { addComment } from "../../../src/core/comments.js";
import { saveFile } from "../../../src/core/files.js";
import { SWAGGER_UI_BUNDLE_JS } from "../../../src/server/swagger-ui.gen.js";
import { SWAGGER_UI_CSS } from "../../../src/server/swagger-ui.gen.js";

const { serve } = await import("../../../src/server/server.js");
type ServeInstance = Awaited<ReturnType<typeof serve>>;

process.env.VIBEFLOW_TELEMETRY = "0";


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

describe("v1 read alias parity: legacy and /api/v1 return identical bodies", () => {
  let tempDir: string;
  let instance: ServeInstance;
  let baseUrl: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-v1-parity-"));
    writeConfig(tempDir, { mode: "attach", port: 3700 });
    const todo = createTask(tempDir, {
      title: "P1 parity todo",
      description: "read-alias fixture",
      status: "todo",
      selector: "#parity-todo",
    });
    createTask(tempDir, {
      title: "P1 parity review",
      description: "read-alias fixture",
      status: "review",
      selector: "#parity-review",
      verified: true,
    });
    const commented = createTask(tempDir, {
      title: "P1 parity commented",
      description: "comment fixture",
      status: "todo",
      selector: "#parity-comments",
    });
    await addComment(
      tempDir,
      commented.id,
      "user",
      "parity probe",
      undefined,
      undefined,
      "web",
    );
    const withFiles = createTask(tempDir, {
      title: "P1 parity files",
      description: "file fixture",
      status: "todo",
      selector: "#parity-files",
    });
    saveFile(tempDir, withFiles.id, "note.txt", Buffer.from("hello parity\n"));
    ids["todo"] = todo.id;
    ids["commented"] = commented.id;
    ids["files"] = withFiles.id;

    const port = await getFreePort();
    instance = await serve(undefined, {
      port,
      open: false,
      projectDir: tempDir,
      _testToken: null,
      _testWorkspace: null,
    });
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30000);

  afterAll(async () => {
    await instance?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  async function getRaw(path: string): Promise<{ status: number; text: string }> {
    const res = await fetch(baseUrl + path);
    return { status: res.status, text: await res.text() };
  }

  async function expectParity(legacyPath: string, v1Path: string): Promise<void> {
    const [legacy, v1] = await Promise.all([
      getRaw(legacyPath),
      getRaw(v1Path),
    ]);
    expect(
      v1.status,
      `status mismatch: GET ${v1Path} -> ${v1.status}, GET ${legacyPath} -> ${legacy.status}`,
    ).toBe(legacy.status);
    expect(
      v1.text,
      `body mismatch: GET ${v1Path} differs from GET ${legacyPath}`,
    ).toBe(legacy.text);
  }

  it.each([
    ["list", "/api/tasks", "/api/v1/tasks"],
    ["list filtered", "/api/tasks?status=todo&limit=1", "/api/v1/tasks?status=todo&limit=1"],
    ["get one", `/api/tasks/{id}`, `/api/v1/tasks/{id}`],
    ["comments empty", `/api/tasks/{todo}/comments`, `/api/v1/tasks/{todo}/comments`],
    ["comments listed", `/api/tasks/{commented}/comments`, `/api/v1/tasks/{commented}/comments`],
    ["files listed", `/api/tasks/{files}/files`, `/api/v1/tasks/{files}/files`],
    ["file bytes", `/api/tasks/{files}/files/note.txt`, `/api/v1/tasks/{files}/files/note.txt`],
    ["project", "/api/project", "/api/v1/project"],
    ["me", "/api/user", "/api/v1/me"],
    ["settings", "/api/settings", "/api/v1/settings"],
    ["changelog", "/api/changelog", "/api/v1/changelog"],
  ])("parity: %s", async (_name, legacyT, v1T) => {
    const sub = (t: string): string =>
      t
        .replace("{id}", ids["todo"])
        .replace("{todo}", ids["todo"])
        .replace("{commented}", ids["commented"])
        .replace("{files}", ids["files"]);
    await expectParity(sub(legacyT), sub(v1T));
  });

  it("unknown ids 404 identically on both surfaces", async () => {
    const missing = "a1b2c3d4";
    await expectParity(`/api/tasks/${missing}`, `/api/v1/tasks/${missing}`);
    const legacy = await getRaw(`/api/tasks/${missing}`);
    expect(legacy.status).toBe(404);
  });

  it("malformed ids 400 identically (the app.param guard is inherited)", async () => {
    await expectParity("/api/tasks/xyz", "/api/v1/tasks/xyz");
    const legacy = await getRaw("/api/tasks/xyz");
    expect(legacy.status).toBe(400);
  });

  it("reads only: unmounted v1 writes are a JSON 404, not a new capability", async () => {
    for (const [method, path] of [
      ["POST", "/api/v1/tasks"],
      ["PATCH", `/api/v1/tasks/${ids["todo"]}`],
      ["DELETE", `/api/v1/tasks/${ids["todo"]}`],
      ["POST", `/api/v1/tasks/${ids["commented"]}/comments`],
      ["GET", "/api/v1/no-such-route"],
    ] as const) {
      const res = await fetch(baseUrl + path, { method });
      expect(res.status, `${method} ${path} must not execute`).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
    // And the 404 did not execute anything: the task is still there.
    const still = await getRaw(`/api/tasks/${ids["todo"]}`);
    expect(still.status).toBe(200);
  });

  it("a well-formed X-Vibeflow-Scope header is accepted locally (single project, ignored)", async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      headers: { "X-Vibeflow-Scope": "board-1" },
    });
    expect(res.status).toBe(200);
  });

  it("a malformed X-Vibeflow-Scope header is a 400, not a silent route-on", async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks`, {
      headers: { "X-Vibeflow-Scope": "not a board\tid" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_SCOPE" });
  });

  it("docs viewer renders the spec from our own assets (no CDN)", async () => {
    const res = await fetch(`${baseUrl}/api/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("/api/openapi.json");
    expect(html).toContain("/api/docs/swagger-ui-bundle.js");
    expect(html).toContain("/api/docs/swagger-ui.css");
    expect(html).toContain("swagger-ui");
    // No CDN: no external script, stylesheet, or fetch target anywhere.
    const external = [
      ...html.matchAll(/<(script|link)[^>]+(src|href)=["']([^"']+)["']/g),
    ]
      .map((m) => m[3])
      .filter((u) => /^https?:\/\//.test(u));
    expect(external, `CDN references must not exist: ${external.join(", ")}`).toEqual(
      [],
    );
    // The page never auto-injects a credential: no token/cookie/credential
    // wiring beyond the user's own Authorize dialog.
    expect(html).not.toMatch(/document\.cookie|localStorage|sessionStorage/);
  });

  it("docs assets are served byte-identical to the vendored source", async () => {
    const js = await fetch(`${baseUrl}/api/docs/swagger-ui-bundle.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toBe(SWAGGER_UI_BUNDLE_JS);
    const css = await fetch(`${baseUrl}/api/docs/swagger-ui.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("css");
    expect(await css.text()).toBe(SWAGGER_UI_CSS);
  });

});
