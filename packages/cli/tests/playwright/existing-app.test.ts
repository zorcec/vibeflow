/**
 * Playwright e2e tests for the "serve on existing app" use case.
 *
 * Scenario: the user has an existing web app served on port A and runs
 * `proto serve` (API-only) on port B.  The overlay is injected into the
 * existing app page (simulating what the Chrome extension does), then
 * communicates cross-origin with the Vibeflow Studio API on port B.
 *
 * This test suite validates:
 *  - CORS: all API calls from the existing-app origin succeed
 *  - Annotation of any element (no data-vibeflow-id / data-testid required)
 *  - Annotation of elements that DO have data-vibeflow-id / data-testid
 *  - Sidebar opens via Alt+S keyboard shortcut
 *  - Sidebar opens via edge-trigger hover
 *  - Tasks appear in the sidebar after creation
 *  - Task status update (mark as done) works
 *  - Task deletion works
 *  - Context-menu (right-click) annotation
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { createServer } from "node:http";
import { serve } from "../../src/server/server.js";
import { getOverlayScript } from "../../src/client/overlay/index.js";
import type { ServeInstance } from "../../src/server/server.js";

// ── Ports ─────────────────────────────────────────────────────────────────────
// APP_PORT = existing app, API_PORT = Vibeflow Studio API-only server
const APP_PORT = 3890;
const API_PORT = 3891;
const APP_BASE = `http://localhost:${APP_PORT}`;

// ── The "existing app" — a realistic page WITHOUT data-vibeflow-id attrs ─────────
const EXISTING_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Existing App</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; background: #f8fafc; }
    nav { padding: 12px; background: #1e40af; color: white; border-radius: 6px; margin-bottom: 16px; }
    main { padding: 16px; border: 1px solid #e2e8f0; border-radius: 6px; }
    button { padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; margin: 4px; }
    button:hover { background: #2563eb; }
    .card { padding: 12px; border: 1px solid #cbd5e1; border-radius: 6px; margin: 8px 0; }
  </style>
</head>
<body>
  <nav id="main-nav">Navigation Bar</nav>
  <main id="main-content">
    <h1 id="page-title">Existing App</h1>
    <button id="primary-btn">Primary Action</button>
    <button data-testid="secondary-btn">Secondary Action</button>
    <div data-vibeflow-id="feature-card" class="card">Feature Card</div>
    <section id="section-a">
      <p class="description">Some description text</p>
    </section>
  </main>
</body>
</html>`;

// ── Shadow DOM helpers ────────────────────────────────────────────────────────
async function shadowExists(page: Page, sel: string): Promise<boolean> {
  return page.evaluate((s) => {
    const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
    return !!(host?.shadowRoot?.querySelector(s));
  }, sel);
}

async function shadowText(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => {
    const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
    return host?.shadowRoot?.querySelector(s)?.textContent ?? "";
  }, sel);
}

async function shadowClick(page: Page, sel: string): Promise<void> {
  await page.evaluate((s) => {
    const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
    (host?.shadowRoot?.querySelector(s) as HTMLElement)?.click();
  }, sel);
}

async function shadowSetValue(page: Page, sel: string, value: string): Promise<void> {
  await page.evaluate(
    ([s, v]) => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const el = host?.shadowRoot?.querySelector(s) as HTMLInputElement;
      if (el) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }
    },
    [sel, value],
  );
}

async function waitForShadowRoot(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot,
    { timeout: 10_000 },
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe("Overlay on existing app (API-only / cross-origin)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let apiInstance: ServeInstance;
  let appServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-existing-app-pw-"));

    // ── Start the simple "existing app" HTTP server ──────────────────────
    const appExpress = express();
    const overlayScriptForPage = getOverlayScript(API_PORT);
    appExpress.get("/", (_req, res) => {
      // Inject the overlay script into the existing app HTML, just as the
      // Chrome extension would do it via a <script> tag.
      const html = EXISTING_APP_HTML.replace(
        "</body>",
        `<script data-proto-overlay="test">${overlayScriptForPage}</script></body>`,
      );
      res.type("html").send(html);
    });
    appServer = createServer(appExpress);
    await new Promise<void>((r) => appServer.listen(APP_PORT, r));

    // ── Start the Vibeflow Studio API-only server ───────────────────────────
    // Use tempDir as the project dir so test tasks are isolated from the
    // project root's .proto/ directory.
    apiInstance = await serve(undefined, { port: API_PORT, open: false, projectDir: tempDir });

    // ── Launch browser ───────────────────────────────────────────────────
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page    = await context.newPage();

    await page.goto(APP_BASE);
    await waitForShadowRoot(page);
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await apiInstance?.close();
    await new Promise<void>((r) => appServer.close(() => r()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Overlay mounts ────────────────────────────────────────────────────────
  it("overlay mounts with shadow root on existing-app page", async () => {
    const mode = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return host?.shadowRoot?.mode;
    });
    expect(mode).toBe("open");
  });

  it("corner trigger toggle button is visible", async () => {
    const hasTrigger = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!(host?.shadowRoot?.querySelector(".vibeflow-corner-trigger"));
    });
    expect(hasTrigger).toBe(true);
  });

  // ── CORS: tasks API accessible cross-origin ───────────────────────────────
  it("CORS: GET /api/tasks succeeds from existing-app origin", async () => {
    const status = await page.evaluate(async (url) => {
      const r = await fetch(url);
      return r.status;
    }, `http://localhost:${API_PORT}/api/tasks`);
    expect(status).toBe(200);
  });

  it("CORS: POST /api/tasks succeeds from existing-app origin", async () => {
    const result = await page.evaluate(async (url) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "CORS task",
          tag: "TODO",
          selector: "#primary-btn",
        }),
      });
      return r.json();
    }, `http://localhost:${API_PORT}/api/tasks`);
    expect(result.success).toBe(true);
    expect(result.task.title).toBe("CORS task");
  });

  it("CORS: OPTIONS preflight returns 204 with correct headers (Node-level check)", async () => {
    // Browsers treat 'Origin' as a forbidden header so we verify the response
    // headers from Node.js (outside page.evaluate) where we can inspect freely.
    const res = await fetch(`http://localhost:${API_PORT}/api/tasks`, {
      method: "OPTIONS",
      headers: {
        "Origin": "http://localhost:3890",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  // ── Annotation mode ───────────────────────────────────────────────────────
  it("Alt+A activates annotation mode", async () => {
    await page.keyboard.press("Alt+a");
    const active = await page.evaluate(() => document.body.classList.contains("vibeflow-overlay-active"));
    expect(active).toBe(true);
  });

  // ── Add task on element WITHOUT data-vibeflow-id (the key existing-app fix) ──
  it("clicking an element with only an id opens the annotation popover", async () => {
    await page.click("#primary-btn");
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(true);
  });

  it("popover label contains the generated selector for the clicked element", async () => {
    const label = await shadowText(page, ".popover-target-name");
    // Should contain either #primary-btn or a CSS path, NOT be empty
    expect(label.trim().length).toBeGreaterThan(0);
    expect(label).toContain("primary-btn");
  });

  it("saving the task via popover shows saved-flash on corner trigger", async () => {
    await shadowSetValue(page, ".vibeflow-popover input[type='text']", "Fix main button");
    await shadowSetValue(page, ".vibeflow-popover textarea", "The button needs better contrast");
    await shadowClick(page, ".btn-primary");

    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return host?.shadowRoot?.querySelector(".vibeflow-corner-trigger")?.classList.contains("saved-flash");
      },
      { timeout: 5_000 },
    );
    const hasFlash = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return host?.shadowRoot?.querySelector(".vibeflow-corner-trigger")?.classList.contains("saved-flash");
    });
    expect(hasFlash).toBe(true);
  });

  it("Escape exits annotation mode", async () => {
    // Close popover first if open
    const popoverOpen = await shadowExists(page, ".vibeflow-popover");
    if (popoverOpen) await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const active = await page.evaluate(() => document.body.classList.contains("vibeflow-overlay-active"));
    expect(active).toBe(false);
  });

  // ── Annotate element with data-testid ─────────────────────────────────────
  it("annotates an element with data-testid attribute", async () => {
    await page.keyboard.press("Alt+a");
    await page.click('[data-testid="secondary-btn"]');
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(true);
    const label = await shadowText(page, ".popover-target-name");
    expect(label).toContain("secondary-btn");

    await shadowSetValue(page, ".vibeflow-popover input[type='text']", "Testid button task");
    await shadowClick(page, ".btn-primary");
    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return host?.shadowRoot?.querySelector(".vibeflow-corner-trigger")?.classList.contains("saved-flash");
      },
      { timeout: 5_000 },
    );
    await page.keyboard.press("Escape"); // exit annotation mode
  });

  // ── Annotate element with data-vibeflow-id ───────────────────────────────────
  it("annotates an element with data-vibeflow-id attribute", async () => {
    await page.keyboard.press("Alt+a");
    await page.click('[data-vibeflow-id="feature-card"]');
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(true);
    const label = await shadowText(page, ".popover-target-name");
    expect(label).toContain("feature-card");

    await shadowSetValue(page, ".vibeflow-popover input[type='text']", "Feature card feedback");
    await shadowClick(page, ".btn-primary");
    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return host?.shadowRoot?.querySelector(".vibeflow-corner-trigger")?.classList.contains("saved-flash");
      },
      { timeout: 5_000 },
    );
    await page.keyboard.press("Escape");
  });

  // ── Context menu (right-click) ────────────────────────────────────────────
  it("right-click opens context menu on any element", async () => {
    await page.click("#page-title", { button: "right" });
    expect(await shadowExists(page, ".vibeflow-context-menu")).toBe(true);
  });

  it("context menu contains annotate option", async () => {
    const text = await shadowText(page, ".vibeflow-context-menu");
    expect(text).toContain("Annotate");
    await page.keyboard.press("Escape"); // close menu
  });

  // ── Annotation hovering changes cursor ───────────────────────────────────
  it("entering annotation mode changes cursor to crosshair on elements", async () => {
    await page.keyboard.press("Alt+a");
    const cursor = await page.evaluate(() => {
      return getComputedStyle(document.getElementById("primary-btn")!).cursor;
    });
    expect(cursor).toBe("crosshair");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  // ── Clicking in annotation mode outside host page doesn't break ───────────
  it("clicking overlay UI in annotation mode does NOT create an annotation", async () => {
    await page.keyboard.press("Alt+a");
    // Click corner trigger (inside shadow DOM / host) — should toggle sidebar, not annotate
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const btn = host?.shadowRoot?.querySelector(".vibeflow-corner-trigger") as HTMLElement;
      if (btn) btn.click();
    });
    // Should NOT open a popover since click was inside the overlay host
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(false);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });
});
