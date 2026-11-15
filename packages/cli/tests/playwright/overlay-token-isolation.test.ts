/**
 * Playwright test for overlay style isolation (ticket P7.1).
 *
 * The overlay renders inside a shadow root, and `:host { all: initial }`
 * does NOT reset custom properties — they inherit straight through the
 * shadow boundary. So a hostile host page that declares our token names on
 * `:root` would repaint the overlay. The `:host` token block at the top of
 * overlay.css (generated from packages/ui/src/kanban/themes.css, the same
 * source the board uses) re-declares the whole `--p-*` / `--t-*` /
 * `--vibeflow-*` namespace with dark values, so the overlay's own values
 * always win.
 *
 * This spec proves it: the overlay renders once on a neutral host and once
 * on a hostile host (whose `:root` declares our token names with loudly
 * wrong values), and the rendered pixels inside the shadow root must be
 * identical. A computed-style assertion pins real elements to their
 * intended dark values on the hostile page, so a future refactor cannot
 * silently fall back.
 *
 * Each host is served from its own directory with an identically named
 * page: the overlay's page switcher lists served pages, so two differently
 * named pages would differ in content (not style) and poison the pixel
 * comparison.
 *
 * Style notes (repo convention): plain vitest assertions on evaluated
 * values, never playwright expect matchers; shadow DOM is pierced
 * explicitly via the host's shadowRoot (see existing-app.test.ts). No
 * waitForTimeout anywhere.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { guardContext, type ErrorGuard } from "./error-guard";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const NEUTRAL_PORT = 3986;
const HOSTILE_PORT = 3987;

// Identical body markup on both hosts — the ONLY difference is the hostile
// <style> block, which declares our token names on :root with loudly wrong
// values. Custom properties alone render nothing on plain HTML, so any
// pixel difference between the two pages comes from the overlay being
// repainted (or not).
const BODY_MARKUP = `<main><h1 id="title">Hello</h1><button id="buy">Buy now</button></main>`;

const NEUTRAL_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Token host</title></head><body>${BODY_MARKUP}</body></html>`;

const HOSTILE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Token host</title>
<style>
  :root {
    --t-bg: magenta;
    --t-text: lime;
    --t-border: magenta;
    --t-accent: lime;
    --p-bg: magenta;
    --p-text: lime;
    --p-text-sub: magenta;
    --p-border: lime;
    --vibeflow-surface-elevated: magenta;
    --vibeflow-accent-strong: lime;
    --vibeflow-text-primary: magenta;
    --vibeflow-border-strong: lime;
  }
</style>
</head><body>${BODY_MARKUP}</body></html>`;

async function waitForOverlay(page: Page): Promise<void> {
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
  // The agent-chat trigger consumes var(--vibeflow-*) for its background,
  // border, and icon color — it is the always-visible canary for the
  // private namespace. (Flag-gated: VIBEFLOW_FEATURES=CHAT in beforeAll.)
  await page.waitForFunction(
    () => {
      const host = document.querySelector(
        "#vibeflow-studio-root",
      ) as HTMLElement | null;
      return (
        host?.shadowRoot?.querySelector('[data-testid="chat-trigger"]') != null
      );
    },
    undefined,
    { timeout: 15_000 },
  );
}

async function hostScreenshot(page: Page): Promise<Buffer> {
  return page.locator("#vibeflow-studio-root").screenshot();
}

async function shadowTriggerBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    const el = host?.shadowRoot?.querySelector(
      '[data-testid="chat-trigger"]',
    ) as HTMLElement | null;
    if (!el) return "missing";
    return getComputedStyle(el).backgroundColor;
  });
}

async function hostToken(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    if (!host) return "missing-host";
    return getComputedStyle(host).getPropertyValue(n).trim();
  }, name);
}

describe("Overlay token isolation on :host (P7.1)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let tempDir: string;
  let neutralInstance: ServeInstance;
  let hostileInstance: ServeInstance;
  let guard: ErrorGuard;

  beforeAll(async () => {
    process.env.VIBEFLOW_FEATURES = "CHAT";
    tempDir = mkdtempSync(join(tmpdir(), "vf-token-isolation-pw-"));
    const neutralDir = join(tempDir, "neutral");
    const hostileDir = join(tempDir, "hostile");
    mkdirSync(neutralDir);
    mkdirSync(hostileDir);
    writeFileSync(join(neutralDir, "index.html"), NEUTRAL_HTML);
    writeFileSync(join(hostileDir, "index.html"), HOSTILE_HTML);
    neutralInstance = await serve(neutralDir, {
      port: NEUTRAL_PORT,
      open: false,
      quiet: true,
      projectDir: neutralDir,
    } as never);
    hostileInstance = await serve(hostileDir, {
      port: HOSTILE_PORT,
      open: false,
      quiet: true,
      projectDir: hostileDir,
    } as never);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    guard = guardContext(context);
  });

  afterEach(() => guard.assertNoErrors());

  afterAll(async () => {
    delete process.env.VIBEFLOW_FEATURES;
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await neutralInstance?.close().catch(() => {});
    await hostileInstance?.close().catch(() => {});
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("renders identical pixels inside the shadow root on neutral and hostile hosts", async () => {
    const neutral = await context.newPage();
    try {
      await neutral.goto(`http://localhost:${NEUTRAL_PORT}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(neutral);
      var neutralShot = await hostScreenshot(neutral);
    } finally {
      await neutral.close();
    }
    const hostile = await context.newPage();
    try {
      await hostile.goto(`http://localhost:${HOSTILE_PORT}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(hostile);
      const hostileShot = await hostScreenshot(hostile);
      expect(hostileShot.equals(neutralShot)).toBe(true);
    } finally {
      await hostile.close();
    }
  });

  it("computed styles resolve to the intended dark values on a hostile host", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${HOSTILE_PORT}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(page);
      // Real element paint: the chat trigger's theme tokens survive magenta/lime :root.
      expect(await shadowTriggerBackground(page)).toBe("rgb(5, 13, 26)");
      // Each namespace re-declared on :host beats the hostile inheritance.
      expect(await hostToken(page, "--vibeflow-surface-elevated")).toBe("#050d1a");
      expect(await hostToken(page, "--p-text")).toBe("#e2e8f0");
      expect(await hostToken(page, "--t-text")).toBe("#e2e8f0");
      expect(await hostToken(page, "--t-bg")).toBe("#020c1b");
    } finally {
      await page.close();
    }
  });
});
