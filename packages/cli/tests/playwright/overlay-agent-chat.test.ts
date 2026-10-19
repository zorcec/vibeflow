/**
 * Playwright tests for the overlay agent chat panel (ticket 0847833f).
 *
 * Covers (no model needed — nothing is ever sent to pi):
 * - Flag ON: chat trigger renders in the shadow root, opens a live panel,
 *   a chat session is created server-side, close tears it down.
 * - Flag OFF: no chat trigger in the shadow DOM — zero surface.
 *
 * Style notes (repo convention): plain vitest assertions on evaluated
 * values, never playwright expect matchers; shadow DOM is pierced
 * explicitly via the host's shadowRoot (see existing-app.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { guardContext, type ErrorGuard } from "./error-guard";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3914;
const BASE = `http://localhost:${PORT}`;
const PAGE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Chat Page</title></head><body><main><h1 id="title">Hello</h1><button id="buy">Buy now</button></main></body></html>`;

async function waitForShadowRoot(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      !!(
        document.querySelector(
          "#vibeflow-studio-root",
        ) as HTMLElement | null
      )?.shadowRoot,
    undefined,
    { timeout: 15_000 },
  );
}

async function shadowExists(page: Page, sel: string): Promise<boolean> {
  return page.evaluate((s) => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    return !!host?.shadowRoot?.querySelector(s);
  }, sel);
}

async function shadowClick(page: Page, sel: string): Promise<void> {
  await page.evaluate((s) => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    (host?.shadowRoot?.querySelector(s) as HTMLElement | null)?.click();
  }, sel);
}

async function waitForShadow(
  page: Page,
  sel: string,
  present: boolean,
  timeoutMs = 15_000,
): Promise<void> {
  await page.waitForFunction(
    ([s, want]: [string, boolean]) => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement | null;
      return (host?.shadowRoot?.querySelector(s) != null) === want;
    },
    [sel, present] as [string, boolean],
    { timeout: timeoutMs },
  );
}

describe("Overlay agent chat panel", () => {
  let browser: Browser;
  let context: BrowserContext;
  let tempDir: string;
  let instance: ServeInstance;
  let guard: ErrorGuard;

  beforeAll(async () => {
    // Multi-flag value proves the list grammar: CHAT plus a future flag.
    process.env.VIBEFLOW_FEATURES = "CHAT, some-future-flag";
    tempDir = mkdtempSync(join(tmpdir(), "vf-chat-pw-"));
    writeFileSync(join(tempDir, "index.html"), PAGE_HTML);
    instance = await serve(tempDir, {
      port: PORT,
      open: false,
      quiet: true,
      projectDir: tempDir,
    } as never);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    guard = guardContext(context);
  }, 120_000);

  afterEach(() => guard.assertNoErrors());

  afterAll(async () => {
    delete process.env.VIBEFLOW_FEATURES;
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await instance?.close().catch(() => {});
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("flag on: trigger renders, opens a live panel, close tears it down", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle" });
      await waitForShadowRoot(page);
      await waitForShadow(page, '[data-testid="chat-trigger"]', true);
      await shadowClick(page, '[data-testid="chat-trigger"]');
      // Panel mounts and creates a server session (pi binary exists in
      // this environment, so the input enables once ready).
      await waitForShadow(page, '[data-testid="chat-dock"]', true);
      await waitForShadow(page, '[data-testid="chat-panel"]', true);
      await page.waitForFunction(
        () => {
          const host = document.querySelector(
            "#vibeflow-studio-root",
          ) as HTMLElement | null;
          const el = host?.shadowRoot?.querySelector(
            '[data-testid="chat-input"]',
          );
          return el instanceof HTMLTextAreaElement && !el.disabled;
        },
        undefined,
        { timeout: 20_000 },
      );
      await shadowClick(page, '[data-testid="chat-close"]');
      await waitForShadow(page, '[data-testid="chat-dock"]', false);
    } finally {
      await page.close().catch(() => {});
    }
  }, 120_000);

  it("flag off: no chat trigger is rendered", async () => {
    delete process.env.VIBEFLOW_FEATURES;
    const dir2 = mkdtempSync(join(tmpdir(), "vf-chat-pw-off-"));
    writeFileSync(join(dir2, "index.html"), PAGE_HTML);
    const instance2 = (await serve(dir2, {
      port: PORT + 1,
      open: false,
      quiet: true,
      projectDir: dir2,
    } as never)) as ServeInstance;
    process.env.VIBEFLOW_FEATURES = "CHAT";
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${PORT + 1}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForShadowRoot(page);
      // Give the overlay a moment to mount, then assert ABSENCE —
      // zero surface means the elements never enter the shadow DOM.
      await page.waitForTimeout(2000);
      expect(await shadowExists(page, '[data-testid="chat-trigger"]')).toBe(false);
      expect(await shadowExists(page, '[data-testid="chat-dock"]')).toBe(false);
    } finally {
      await page.close().catch(() => {});
      await instance2?.close().catch(() => {});
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 120_000);
});
