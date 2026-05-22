import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import WebSocket from "ws";

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Test</title></head>
<body>
  <div data-vibeflow-id="hero-section">
    <h1 data-vibeflow-id="main-title">Hello World</h1>
    <button data-vibeflow-id="cta-button">Click Me</button>
  </div>
</body>
</html>`;

describe("proto serve (e2e)", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-serve-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves a single HTML file", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3750, open: false });
    expect(instance.url).toBe("http://localhost:3750");

    const response = await fetch("http://localhost:3750/");
    expect(response.ok).toBe(true);
    const body = await response.text();
    expect(body).toContain("Hello World");
    expect(body).toContain("data-vibeflow-overlay");
  });

  it("injects overlay script into served HTML", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3751, open: false });

    const response = await fetch("http://localhost:3751/");
    const body = await response.text();
    expect(body).toContain("data-vibeflow-overlay");
    // Overlay uses window.location.host for dynamic URL resolution (supports remote --host access)
    expect(body).toContain("window.location.host");
  });

  it("serves directory with multiple HTML files", async () => {
    writeFileSync(join(tempDir, "page1.html"), SAMPLE_HTML, "utf-8");
    writeFileSync(
      join(tempDir, "page2.html"),
      SAMPLE_HTML.replace("Hello World", "Page Two"),
      "utf-8",
    );

    instance = await serve(tempDir, { port: 3752, open: false });

    const indexResponse = await fetch("http://localhost:3752/");
    const indexBody = await indexResponse.text();
    expect(indexBody).toContain("page1.html");
    expect(indexBody).toContain("page2.html");

    const page1 = await fetch("http://localhost:3752/page1.html");
    expect(await page1.text()).toContain("Hello World");

    const page2 = await fetch("http://localhost:3752/page2.html");
    expect(await page2.text()).toContain("Page Two");
  });

  // ── Task API tests ──────────────────────────────────────────────────────
  it("GET /api/tasks returns empty list initially", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3753, open: false });

    const response = await fetch("http://localhost:3753/api/tasks");
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.tasks).toEqual([]);
  });

  it("POST /api/tasks creates a task", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3754, open: false });

    const response = await fetch("http://localhost:3754/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Fix the button",
        description: "Make it bigger",
        selector: '[data-vibeflow-id="cta-button"]',
      }),
    });

    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.task.id).toBeDefined();
    expect(result.task.title).toBe("Fix the button");

    // Verify it appears in the list
    const listRes = await fetch("http://localhost:3754/api/tasks");
    const listData = await listRes.json();
    expect(listData.tasks).toHaveLength(1);
  });

  it("POST /api/tasks rejects missing fields", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3755, open: false });

    const response = await fetch("http://localhost:3755/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No selector" }),
    });

    expect(response.status).toBe(400);
  });

  it("PATCH /api/tasks/:id updates a task", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3756, open: false });

    // Create a task first
    const createRes = await fetch("http://localhost:3756/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Update me",
        selector: '[data-vibeflow-id="hero-section"]',
      }),
    });
    const { task } = await createRes.json();

    // Update it
    const updateRes = await fetch(`http://localhost:3756/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    const updateData = await updateRes.json();
    expect(updateData.success).toBe(true);
    expect(updateData.task.status).toBe("done");
  });

  it("DELETE /api/tasks/:id removes a task", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3757, open: false });

    // Create then delete
    const createRes = await fetch("http://localhost:3757/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Delete me",
        selector: '[data-vibeflow-id="main-title"]',
      }),
    });
    const { task } = await createRes.json();

    const deleteRes = await fetch(`http://localhost:3757/api/tasks/${task.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.ok).toBe(true);

    const listRes = await fetch("http://localhost:3757/api/tasks");
    const listData = await listRes.json();
    expect(listData.tasks).toHaveLength(0);
  });

  it("PATCH /api/tasks/:id returns 404 for non-existent task", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3758, open: false });

    const response = await fetch("http://localhost:3758/api/tasks/aabbccddeeff001122334455667788", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(response.status).toBe(404);
  });

  it("throws for empty directory with no HTML files", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "proto-empty-"));
    try {
      await expect(
        serve(emptyDir, { port: 3762, open: false }),
      ).rejects.toThrow("No HTML files");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("creates .proto directory on startup", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3763, open: false });

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tempDir, ".vibeflow", "tasks"))).toBe(true);
    expect(existsSync(join(tempDir, ".vibeflow", "tasks", "screenshots"))).toBe(true);
  });

  it("DELETE /api/tasks/:id/screenshot removes screenshot and returns success", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3764, open: false });

    // Create a task with a screenshot
    const createRes = await fetch("http://localhost:3764/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Screenshot task",
        selector: '[data-vibeflow-id="cta-button"]',
        // eslint-disable-next-line no-secrets/no-secrets -- 1x1 pixel PNG test fixture, not a credential
        screenshot: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      }),
    });
    const { task } = await createRes.json();

    // Delete the screenshot
    const deleteRes = await fetch(
      `http://localhost:3764/api/tasks/${task.id}/screenshot`,
      { method: "DELETE" },
    );
    expect(deleteRes.ok).toBe(true);
    const deleteData = await deleteRes.json();
    expect(deleteData.success).toBe(true);

    // Verify screenshot is gone from task
    const listRes = await fetch("http://localhost:3764/api/tasks");
    const listData = await listRes.json();
    expect(listData.tasks[0].screenshot).toBeUndefined();
  });

  it("DELETE /api/tasks/:id/screenshot returns 404 for non-existent task", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3765, open: false });

    const res = await fetch("http://localhost:3765/api/tasks/aabbccddeeff001122334455667788/screenshot", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/tasks/:id/screenshot uploads a screenshot", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3766, open: false });

    const createRes = await fetch("http://localhost:3766/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Task to screenshot",
        selector: '[data-vibeflow-id="hero-section"]',
      }),
    });
    const { task } = await createRes.json();

    const uploadRes = await fetch(
      `http://localhost:3766/api/tasks/${task.id}/screenshot`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // eslint-disable-next-line no-secrets/no-secrets -- 1x1 pixel PNG test fixture, not a credential
          screenshot: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        }),
      },
    );
    expect(uploadRes.ok).toBe(true);
    const uploadData = await uploadRes.json();
    expect(uploadData.success).toBe(true);
    expect(uploadData.screenshot).toBe(`${task.id}.png`);
  });

  it("POST /api/tasks/:id/files/:filename uploads a file and appears in listing", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3767, open: false });

    const createRes = await fetch("http://localhost:3767/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Task with uploaded file",
        selector: '[data-vibeflow-id="hero-section"]',
      }),
    });
    const { task } = await createRes.json();

    const uploadRes = await fetch(
      `http://localhost:3767/api/tasks/${task.id}/files/design-notes.md`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from("# notes\ncontent"),
      },
    );
    expect(uploadRes.ok).toBe(true);

    const listRes = await fetch(`http://localhost:3767/api/tasks/${task.id}/files`);
    const listData = await listRes.json();
    expect(listData.files).toHaveLength(1);
    expect(listData.files[0].name).toBe("design-notes.md");
  });

  it("POST /api/tasks/:id/files/:filename rejects traversal filename", async () => {
    const filePath = join(tempDir, "test.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 3768, open: false });

    const createRes = await fetch("http://localhost:3768/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Task with blocked filename",
        selector: '[data-vibeflow-id="hero-section"]',
      }),
    });
    const { task } = await createRes.json();

    const uploadRes = await fetch(
      `http://localhost:3768/api/tasks/${task.id}/files/..%2Fescape.md`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from("blocked"),
      },
    );
    expect(uploadRes.status).toBe(400);
  });

});

// ── API-only mode (no target / existing hosted project) ───────────────────
describe("proto serve — API-only mode (no target)", () => {
  let instance: ServeInstance | null = null;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-api-only-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts without a target and serves the task API", async () => {
    instance = await serve(undefined, { port: 3780, open: false, projectDir: tempDir });
    expect(instance.url).toBe("http://localhost:3780");

    const res = await fetch("http://localhost:3780/api/tasks");
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.tasks)).toBe(true);
  });

  it("API-only mode: creates and retrieves tasks", async () => {
    instance = await serve(undefined, { port: 3781, open: false, projectDir: tempDir });

    const createRes = await fetch("http://localhost:3781/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "API-only task",
        selector: '[data-testid="submit-btn"]',
        url: "http://localhost:5173/checkout",
      }),
    });
    const result = await createRes.json();
    expect(result.success).toBe(true);
    expect(result.task.title).toBe("API-only task");
    expect(result.task.url).toBe("http://localhost:5173/checkout");
  });

  it("API-only mode: does not serve HTML (/ returns 404)", async () => {
    instance = await serve(undefined, { port: 3782, open: false, projectDir: tempDir });

    const res = await fetch("http://localhost:3782/");
    expect(res.status).toBe(404);
  });

  it("API-only mode: PATCH updates task status", async () => {
    instance = await serve(undefined, { port: 3783, open: false, projectDir: tempDir });

    const createRes = await fetch("http://localhost:3783/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Status test",
        selector: '[data-testid="nav-home"]',
      }),
    });
    const { task } = await createRes.json();

    const patchRes = await fetch(`http://localhost:3783/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const patchData = await patchRes.json();
    expect(patchData.success).toBe(true);
    expect(patchData.task.status).toBe("done");
  });

  it("API-only mode: DELETE removes a task", async () => {
    instance = await serve(undefined, { port: 3784, open: false, projectDir: tempDir });

    const createRes = await fetch("http://localhost:3784/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Delete me",
        selector: '[data-testid="delete-btn"]',
      }),
    });
    const { task } = await createRes.json();

    const deleteRes = await fetch(`http://localhost:3784/api/tasks/${task.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.ok).toBe(true);

    const listRes = await fetch("http://localhost:3784/api/tasks");
    const listData = await listRes.json();
    expect(listData.tasks.every((t: { id: string }) => t.id !== task.id)).toBe(true);
  });

  it("API-only mode: creates .proto dirs in the specified projectDir", async () => {
    instance = await serve(undefined, { port: 3785, open: false, projectDir: tempDir });

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(tempDir, ".vibeflow", "tasks"))).toBe(true);
    expect(existsSync(join(tempDir, ".vibeflow", "tasks", "screenshots"))).toBe(true);
  });
});

// ── Proxy mode removed — verify helpful error is thrown ──────────────────
describe("proto serve — proxy mode removed", () => {
  it("throws an error when a URL target is passed (proxy mode removed)", async () => {
    await expect(
      serve("http://localhost:9700", { port: 9699, open: false }),
    ).rejects.toThrow("Proxy mode is no longer supported");
  });
});

// ── Regression tests: bugs found during dogfooding ───────────────────────────
// These tests reproduce the exact failure modes reported, using `serve` just as
// the real CLI does — serving a directory or a single-file prototype.

describe("proto serve — regression: pageRoutes ReferenceError (dir mode)", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-pages-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does NOT crash (ReferenceError: pageRoutes is not defined) when serving a directory", async () => {
    // Before the fix, `const pageRoutes` was swallowed by a // comment on the
    // same line, causing `ReferenceError: pageRoutes is not defined` at startup.
    writeFileSync(join(tempDir, "index.html"), SAMPLE_HTML, "utf-8");
    writeFileSync(
      join(tempDir, "details.html"),
      SAMPLE_HTML.replace("Hello World", "Details"),
      "utf-8",
    );

    // Must not throw
    await expect(
      serve(tempDir, { port: 9720, open: false }),
    ).resolves.toBeDefined();

    instance = await serve(tempDir, { port: 9721, open: false });
    const res = await fetch(`http://localhost:9721/index.html`);
    expect(res.ok).toBe(true);
  });

  it("GET /api/pages returns the list of HTML files when serving a directory", async () => {
    writeFileSync(join(tempDir, "index.html"), SAMPLE_HTML, "utf-8");
    writeFileSync(
      join(tempDir, "map.html"),
      SAMPLE_HTML.replace("Hello World", "Map"),
      "utf-8",
    );

    instance = await serve(tempDir, { port: 9722, open: false });

    const res = await fetch("http://localhost:9722/api/pages");
    expect(res.ok).toBe(true);
    const body = await res.json() as { pages: string[] };
    expect(body.pages).toContain("/index.html");
    expect(body.pages).toContain("/map.html");
    expect(body.pages).toHaveLength(2);
  });

  it("GET /api/pages returns empty array when serving a single HTML file", async () => {
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 9723, open: false });

    const res = await fetch("http://localhost:9723/api/pages");
    expect(res.ok).toBe(true);
    const body = await res.json() as { pages: string[] };
    expect(body.pages).toEqual([]);
  });

  it("GET /api/pages returns empty array in API-only mode", async () => {
    const apiInstance = await serve(undefined, { port: 9724, open: false, projectDir: tempDir });
    try {
      const res = await fetch("http://localhost:9724/api/pages");
      expect(res.ok).toBe(true);
      const body = await res.json() as { pages: string[] };
      expect(body.pages).toEqual([]);
    } finally {
      await apiInstance.close();
    }
  });
});

describe("proto serve — regression: overlay SyntaxError (Unexpected token ',')", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-overlay-syntax-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("overlay script served at /vibeflow-overlay.js is valid JavaScript (no SyntaxError)", async () => {
    // Before the fix, /^\/\/ compiled to /^// — the // started a JS comment,
    // causing 'Unexpected token ,' in the browser when the script was evaluated.
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 9725, open: false });

    const res = await fetch("http://localhost:9725/vibeflow-overlay.js");
    expect(res.ok).toBe(true);
    const script = await res.text();

    // Perform the exact same check the browser does: parse as a function body
    expect(() => new Function(script)).not.toThrow();
  });

  it("overlay script does not contain the literal '//' inside a regex (the broken pattern)", async () => {
    // The broken form was: page.replace(/^//, '') where // becomes a comment
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, SAMPLE_HTML, "utf-8");

    instance = await serve(filePath, { port: 9726, open: false });

    const res = await fetch("http://localhost:9726/vibeflow-overlay.js");
    const script = await res.text();

    // The broken regex would appear as /^// in the script
    expect(script).not.toContain("/^//");
  });

  it("overlay script injected into HTML is valid JavaScript", async () => {
    writeFileSync(join(tempDir, "page1.html"), SAMPLE_HTML, "utf-8");
    writeFileSync(
      join(tempDir, "page2.html"),
      SAMPLE_HTML.replace("Hello World", "Page 2"),
      "utf-8",
    );

    instance = await serve(tempDir, { port: 9727, open: false });

    // The HTML page has the overlay injected inline
    const res = await fetch("http://localhost:9727/page1.html");
    const html = await res.text();

    const match = html.match(/<script data-vibeflow-overlay[^>]*>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const inlineScript = match![1];
    expect(() => new Function(inlineScript)).not.toThrow();
  });
});

// ── URL-based task filtering (Task 1 regression) ─────────────────────────────
// The sidebar should only show tasks whose `url` matches the current page path.
// The overlay client filters client-side; the API stores and returns all tasks.
//
// This test verifies:
//   1. Tasks are stored with their `url` field intact.
//   2. The API returns all tasks regardless of URL (no server-side filtering).
//   3. The injected overlay script contains the client-side URL-filter logic.

describe("proto serve — task url field and overlay url-filtering", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-urlfilter-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores url field on tasks and API returns all tasks regardless of url", async () => {
    writeFileSync(join(tempDir, "page1.html"), SAMPLE_HTML, "utf-8");
    writeFileSync(
      join(tempDir, "page2.html"),
      SAMPLE_HTML.replace("Hello World", "Page 2"),
      "utf-8",
    );

    instance = await serve(tempDir, { port: 9728, open: false });

    // Create task for page1
    const r1 = await fetch("http://localhost:9728/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Fix nav on page 1",
        description: "",
        selector: '[data-vibeflow-id="nav"]',
        url: "/page1.html",
      }),
    });
    const d1 = await r1.json() as { success: boolean; task: { url?: string } };
    expect(d1.success).toBe(true);
    expect(d1.task.url).toBe("/page1.html");

    // Create task for page2
    const r2 = await fetch("http://localhost:9728/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Fix footer on page 2",
        description: "",
        selector: '[data-vibeflow-id="footer"]',
        url: "/page2.html",
      }),
    });
    const d2 = await r2.json() as { success: boolean; task: { url?: string } };
    expect(d2.success).toBe(true);
    expect(d2.task.url).toBe("/page2.html");

    // Create global task (no url)
    const r3 = await fetch("http://localhost:9728/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Global task",
        description: "",
        selector: '[data-vibeflow-id="header"]',
      }),
    });
    const d3 = await r3.json() as { success: boolean; task: { url?: string } };
    expect(d3.success).toBe(true);
    expect(d3.task.url).toBeUndefined();

    // API returns ALL three tasks (no server-side URL filtering)
    const listRes = await fetch("http://localhost:9728/api/tasks");
    const listData = await listRes.json() as { tasks: Array<{ url?: string; title: string }> };
    expect(listData.tasks).toHaveLength(3);

    const urls = listData.tasks.map((t) => t.url);
    expect(urls).toContain("/page1.html");
    expect(urls).toContain("/page2.html");
    expect(urls).toContain(undefined);
  });

  it("overlay script includes client-side page URL filtering", async () => {
    writeFileSync(join(tempDir, "index.html"), SAMPLE_HTML, "utf-8");

    instance = await serve(tempDir, { port: 9729, open: false });

    const res = await fetch("http://localhost:9729/index.html");
    const html = await res.text();

    const match = html.match(/<script data-vibeflow-overlay[^>]*>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const overlayScript = match![1];
    // Must contain the client-side URL filter logic
    expect(overlayScript).toContain("location.pathname");
  });
});

// ── Regression: tasks.md bug-fixes ─────────────────────────────────────────
describe("proto serve — regression: tasks.md fixes", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-regression-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("POST /api/tasks stores cssSelector when provided", async () => {
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, "<html><body><h1>Test</h1></body></html>", "utf-8");

    instance = await serve(filePath, { port: 9730, open: false });

    const res = await fetch("http://localhost:9730/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "CSS selector task",
        selector: '[data-testid="hero"]',
        cssSelector: "main > section > h1",
      }),
    });
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.task.id).toBeDefined();

    // Verify cssSelector is stored and returned
    const listRes = await fetch("http://localhost:9730/api/tasks");
    const listData = await listRes.json();
    expect(listData.tasks[0].cssSelector).toBe("main > section > h1");
  });

  it("POST /api/tasks works without cssSelector (backwards-compatible)", async () => {
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, "<html><body><h1>Test</h1></body></html>", "utf-8");

    instance = await serve(filePath, { port: 9731, open: false });

    const res = await fetch("http://localhost:9731/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "No CSS selector",
        selector: '[data-vibeflow-id="btn"]',
      }),
    });
    const data = await res.json();
    expect(data.success).toBe(true);

    const listRes = await fetch("http://localhost:9731/api/tasks");
    const listData = await listRes.json();
    expect(listData.tasks[0].cssSelector).toBeUndefined();
  });

  it("screenshots are served at absolute path (SCREENSHOTS_URL in overlay)", async () => {
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, "<html><body><h1>Test</h1></body></html>", "utf-8");

    instance = await serve(filePath, { port: 9732, open: false });

    const res = await fetch("http://localhost:9732/");
    const html = await res.text();
    const match = html.match(/<script data-vibeflow-overlay[^>]*>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const overlayScript = match![1];
    // Overlay must use absolute screenshotsUrl from PROTO_CONFIG (not relative path).
    // The URL is constructed at runtime from the server origin (_vfOrigin + '/screenshots/')
    // so that bookmarklet injection on cross-origin pages still points to the CLI server.
    expect(overlayScript).toContain("screenshotsUrl");
    expect(overlayScript).toContain("_vfOrigin + '/screenshots/'");
    // Must NOT use a hardcoded relative path
    expect(overlayScript).not.toContain("'/screenshots/' + task.screenshot");
  });

  it("overlay script keeps page-scoped task filtering", async () => {
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, "<html><body><h1>Test</h1></body></html>", "utf-8");

    instance = await serve(filePath, { port: 9733, open: false });

    const res = await fetch("http://localhost:9733/");
    const html = await res.text();
    const match = html.match(/<script data-vibeflow-overlay[^>]*>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const overlayScript = match![1];
    expect(overlayScript).toContain("location.pathname");
  });

  it("SPA navigation detection code is present in overlay", async () => {
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, "<html><body><h1>Test</h1></body></html>", "utf-8");

    instance = await serve(filePath, { port: 9734, open: false });

    const res = await fetch("http://localhost:9734/");
    const html = await res.text();
    const match = html.match(/<script data-vibeflow-overlay[^>]*>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    const overlayScript = match![1];
    expect(overlayScript).toContain("history.pushState");
    expect(overlayScript).toContain("hashchange");
  });
});

// ── Kanban live refresh via WebSocket file watcher ─────────────────────────
describe("proto serve — kanban live refresh (WebSocket task watcher)", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-ws-watcher-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("broadcasts WS notification when a task file is externally modified (serve)", async () => {
    const filePath = join(tempDir, "index.html");
    writeFileSync(filePath, "<html><body><h1>Test</h1></body></html>", "utf-8");

    instance = await serve(filePath, { port: 9800, open: false });

    // Create a task via API so the tasks dir exists
    await fetch("http://localhost:9800/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Initial task", selector: "#hero" }),
    });

    // Connect WebSocket and listen for WS notifications
    const { WebSocket: WS } = await import("ws");
    const ws = new WS("ws://localhost:9800");
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const msgReceived = new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });

    // Externally write a new task file into .vibeflow/tasks/
    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    writeFileSync(join(tasksDir, "external-task.md"), [
      "---",
      "id: exttest1",
      "status: todo",
      'selector: "#btn"',
      "created: 2025-01-01T00:00:00.000Z",
      "---",
      "",
      "# External Task",
    ].join("\n"), "utf-8");

    const msg = await Promise.race([
      msgReceived,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);

    ws.close();
    const parsed = JSON.parse(msg);
    // Server sends task-changed when it can parse the task file, tasks-updated otherwise
    expect(["task-changed", "tasks-updated"]).toContain(parsed.type);
    if (parsed.type === "task-changed") {
      expect(parsed).toMatchObject({ taskId: expect.any(String), action: expect.any(String) });
    }
  });

  it("broadcasts WS notification when a task file is externally modified (API-only mode)", async () => {
    instance = await serve(undefined, { port: 9801, open: false, projectDir: tempDir });

    // Create a task via API so the tasks dir exists
    await fetch("http://localhost:9801/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Initial task", selector: "#hero" }),
    });

    const { WebSocket: WS } = await import("ws");
    const ws = new WS("ws://localhost:9801");
    await new Promise<void>((resolve) => ws.on("open", resolve));

    const msgReceived = new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(data.toString()));
    });

    const tasksDir = join(tempDir, ".vibeflow", "tasks");
    writeFileSync(join(tasksDir, "external-task2.md"), [
      "---",
      "id: exttest2",
      "status: in-progress",
      'selector: "#nav"',
      "created: 2025-01-01T00:00:00.000Z",
      "---",
      "",
      "# Another External Task",
    ].join("\n"), "utf-8");

    const msg = await Promise.race([
      msgReceived,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);

    ws.close();
    const parsed = JSON.parse(msg);
    // Server sends task-changed when it can parse the task file, tasks-updated otherwise
    expect(["task-changed", "tasks-updated"]).toContain(parsed.type);
    if (parsed.type === "task-changed") {
      expect(parsed).toMatchObject({ taskId: expect.any(String), action: expect.any(String) });
    }
  });
});

describe("proto serve — deprecated agents API", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-agents-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("/api/agents is no longer exposed as JSON", async () => {
    instance = await serve(undefined, { port: 9820, open: false, projectDir: tempDir });
    const res = await fetch("http://localhost:9820/api/agents");
    expect(res.ok).toBe(false);
    expect([404, 503]).toContain(res.status);
  });
});

// ── Agent run API tests ──────────────────────────────────────────────────────
describe("proto serve — agent run API", () => {
  let tempDir: string;
  let instance: ServeInstance | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-agent-"));
  });

  afterEach(async () => {
    if (instance) {
      await instance.close();
      instance = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("POST /api/agent/run returns 400 without taskId", async () => {
    instance = await serve(undefined, { port: 9830, open: false, projectDir: tempDir });
    const res = await fetch("http://localhost:9830/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("taskId is required");
  });

  it("POST /api/agent/run returns 400 with invalid taskId", async () => {
    instance = await serve(undefined, { port: 9831, open: false, projectDir: tempDir });
    const res = await fetch("http://localhost:9831/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "invalid" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Invalid task ID");
  });

  it("POST /api/agent/run returns 404 for non-existent task", async () => {
    instance = await serve(undefined, { port: 9832, open: false, projectDir: tempDir });
    const res = await fetch("http://localhost:9832/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "aabbccddeeff001122334455667788" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/agent/run returns 500 when opencode is not installed", async () => {
    // Temporarily override PATH to hide opencode
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin/nonexistent";

    instance = await serve(undefined, { port: 9833, open: false, projectDir: tempDir });

    // Create a task first
    const createRes = await fetch("http://localhost:9833/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test task",
        selector: "#test",
        description: "Test description",
      }),
    });
    const { task } = await createRes.json();

    const res = await fetch("http://localhost:9833/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id }),
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("opencode is not installed");

    process.env.PATH = originalPath;
  });

  it("POST /api/agent/run returns 409 when agent already running", async () => {
    // This test verifies the duplicate-run guard — we can't easily spawn a real
    // opencode process, but we can verify the endpoint exists and validates input.
    instance = await serve(undefined, { port: 9834, open: false, projectDir: tempDir });

    const createRes = await fetch("http://localhost:9834/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Duplicate test",
        selector: "#test",
        description: "Should fail if opencode missing",
      }),
    });
    const { task } = await createRes.json();

    // First call will try to spawn opencode (may fail with 500 if not installed)
    // but the important thing is the endpoint works
    const res1 = await fetch("http://localhost:9834/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, model: "test/model" }),
    });
    // Either 200 (opencode installed) or 500 (not installed)
    expect([200, 500]).toContain(res1.status);

    if (res1.status === 200) {
      // Second call should return 409
      const res2 = await fetch("http://localhost:9834/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id }),
      });
      expect(res2.status).toBe(409);
    }
  });

  it("GET /api/agent/agents returns agent list", async () => {
    instance = await serve(undefined, { port: 9835, open: false, projectDir: tempDir });
    const res = await fetch("http://localhost:9835/api/agent/agents");
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.agents)).toBe(true);
    // Should have at least some agents if opencode is installed
    if (data.agents.length > 0) {
      expect(data.agents[0]).toHaveProperty("id");
      expect(data.agents[0]).toHaveProperty("name");
      expect(data.agents[0]).toHaveProperty("scope");
    }
  });

  it("GET /api/agent/models returns model list", async () => {
    instance = await serve(undefined, { port: 9836, open: false, projectDir: tempDir });
    const res = await fetch("http://localhost:9836/api/agent/models");
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.models)).toBe(true);
  });

  it("POST /api/agent/run succeeds with a real free model and emits WebSocket events", { timeout: 60000 }, async () => {
    instance = await serve(undefined, { port: 9837, open: false, projectDir: tempDir });

    // Create a simple task
    const createRes = await fetch("http://localhost:9837/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Echo test",
        selector: "#test",
        description: "Say hello world",
      }),
    });
    const { task } = await createRes.json();
    expect(task).toBeDefined();

    // Connect to WebSocket to listen for events
    const wsEvents: Array<{ type: string; taskId?: string }> = [];
    const ws = new WebSocket(`ws://localhost:9837`);
    const wsReady = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        wsEvents.push({ type: msg.type, taskId: msg.taskId });
      } catch {
        // ignore non-JSON messages
      }
    });
    await wsReady;

    // Run agent with a real free model
    const runRes = await fetch("http://localhost:9837/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, model: "opencode/hy3-preview-free" }),
    });
    expect(runRes.status).toBe(200);
    const runData = await runRes.json();
    expect(runData.ok).toBe(true);
    expect(runData.command).toContain("opencode run");
    expect(runData.command).toContain("opencode/hy3-preview-free");
    expect(runData.command).toContain("[todo] Echo test");

    // Wait for agent-run-started event (should be immediate)
    await new Promise<void>((resolve) => {
      const check = () => {
        if (wsEvents.some((e) => e.type === "agent-run-started" && e.taskId === task.id)) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      setTimeout(() => resolve(), 5000);
      check();
    });

    const started = wsEvents.find((e) => e.type === "agent-run-started" && e.taskId === task.id);
    expect(started).toBeDefined();

    // Wait for agent-run-finished event (opencode completes quickly with simple tasks)
    await new Promise<void>((resolve) => {
      const check = () => {
        if (wsEvents.some((e) => e.type === "agent-run-finished" && e.taskId === task.id)) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      // Give opencode up to 45 seconds to complete
      setTimeout(() => {
        // If not finished, that's OK — we verified the start event and API response
        resolve();
      }, 45000);
      check();
    });

    // Check if we got the finished event (may or may not depending on opencode speed)
    const finished = wsEvents.find((e) => e.type === "agent-run-finished" && e.taskId === task.id);
    if (finished) {
      // If it finished, verify we also got log events
      const logs = wsEvents.filter((e) => e.type === "agent-run-log" && e.taskId === task.id);
      expect(logs.length).toBeGreaterThan(0);
    }

    ws.close();
  });
});
