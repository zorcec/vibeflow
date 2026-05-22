/**
 * Playwright smoke tests for the dashboard (React kanban app).
 *
 * Covers:
 *  - Page loads without console errors or warnings
 *  - No CDN tailwindcss.com script is loaded (CSS must be inlined at build time)
 *  - React root renders content (app bootstrapped successfully)
 *  - Kanban board is visible
 *  - No 404 responses for page assets
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3902;
const BASE = `http://localhost:${PORT}`;

describe("Dashboard smoke tests", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;

  const consoleErrors: Array<{ type: string; text: string }> = [];
  const notFoundUrls: string[] = [];

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-smoke-pw-"));
    instance = await serve(undefined, { port: PORT, open: false, projectDir: tempDir });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    // Capture console errors/warnings before navigating
    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") {
        const text = msg.text();
        // Filter browser extension and DevTools noise
        if (
          !text.includes("ERR_FILE_NOT_FOUND") &&
          !text.includes("extension://") &&
          !text.includes("chrome-extension")
        ) {
          consoleErrors.push({ type, text });
        }
      }
    });

    // Track 404 responses (excluding WebSocket upgrades)
    page.on("response", (resp) => {
      if (resp.status() === 404 && !resp.url().includes("/ws")) {
        notFoundUrls.push(resp.url());
      }
    });

    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board", { timeout: 10_000 });
    // Wait for any late-arriving async errors (network-idle is more reliable than a fixed pause)
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads without console errors", async () => {
    const errors = consoleErrors.filter((m) => m.type === "error");
    expect(errors).toEqual([]);
  });

  it("loads without console warnings", async () => {
    const warnings = consoleErrors.filter((m) => m.type === "warning");
    expect(warnings).toEqual([]);
  });

  it("does not load tailwindcss CDN script", async () => {
    // The Tailwind CSS must be inlined (generated at build time), not loaded from CDN.
    // Note: the inline CSS may contain a copyright comment with "tailwindcss.com" — we
    // specifically check no <script> or <link> tag loads from the CDN.
    const noExternalTailwind = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll("script[src]")] as HTMLScriptElement[];
      const links = [...document.querySelectorAll("link[href]")] as HTMLLinkElement[];
      const badScript = scripts.some((s) => s.src.includes("tailwindcss.com") || s.src.includes("cdn.tailwindcss"));
      const badLink = links.some((l) => l.href.includes("tailwindcss.com") || l.href.includes("cdn.tailwindcss"));
      return !badScript && !badLink;
    });
    expect(noExternalTailwind).toBe(true);
  });

  it("renders React root with content", async () => {
    const rootHasChildren = await page.evaluate(() => {
      const root = document.getElementById("root");
      return root != null && root.children.length > 0;
    });
    expect(rootHasChildren).toBe(true);
  });

  it("renders the kanban board", async () => {
    const visible = await page.isVisible("#kanban-board");
    expect(visible).toBe(true);
  });

  it("has no 404 responses for page assets", async () => {
    expect(notFoundUrls).toEqual([]);
  });
});
