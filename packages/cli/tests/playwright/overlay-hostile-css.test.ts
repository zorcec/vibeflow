/**
 * Playwright test for overlay isolation under hostile host CSS (ticket P7.3).
 *
 * P7.1 pinned our token names on `:host` (custom properties inherit through
 * the shadow boundary) and P7.2 pinned the compiled utility subset inside
 * the shadow root. This spec fires all three hostile vectors at once and
 * checks the shadow paint does not move:
 *
 *   1. Global element rules: `* { all: unset }`, a `button` rule with
 *      `!important` red/white/square/zero-paint, `div { display: block
 *      !important }`, and `* { font-family: Comic Sans MS !important;
 *      font-size: 32px !important }`.
 *   2. Custom properties on `:root` using our token names (P7.1's set,
 *      magenta/lime) — included so this spec is self-contained.
 *   3. `* { transition: none !important; transform: scale(2) !important }`
 *      plus a `*::before/::after { content: "X" !important }` rule.
 *
 * Outer-document selectors never match elements inside the shadow tree, so
 * vectors 1–3 can only reach the overlay through (a) the host element
 * itself — it lives in the outer document, where an outer `!important`
 * beats the shadow `:host` rule — and (b) inheritance (font, custom
 * properties) from the host. The pixel assertion screenshots an opaque,
 * square, text-free probe painted ONLY by overlay.css classes
 * (`.vibeflow-popover` + `.popover-header`): full opacity means the
 * visibly-repainted outer page cannot show through (a host-box screenshot
 * would compare the two host pages, not the overlay), square corners avoid
 * leaking the page behind through anti-aliased rounded corners, and no
 * text keeps host-level font inheritance out of the paint.
 *
 * Capture is a FIXED viewport-region clip: the probe's neutral-page box is
 * measured once and the identical region is shot on both pages. An element
 * screenshot would chase the host if hostile layout displaces it and stalls
 * on Playwright's stability wait against the destroyed host-page layout;
 * the fixed region states the property exactly — the same screen region
 * must show the same pixels. Comparison is a direct buffer equality, not
 * `toHaveScreenshot`: no checked-in baseline to drift, no
 * environment-sensitive threshold — the two shots are taken back-to-back
 * in the same browser.
 *
 * Each host is served from its own directory with an identically named
 * page (the overlay's page switcher lists served pages, so two differently
 * named pages would differ in content and poison the comparison).
 *
 * FINDING (P7.3 report): the verbatim attack does displace the overlay at
 * the HOST level — outer `!important` layout rules (`transform: scale(2)`,
 * `all: unset` unhiding head/style text, 32px fallback type, generated
 * "X" content) compound through html → body → host and move the
 * `#vibeflow-studio-root` box itself, which no shadow stylesheet can
 * override by CSS design. The pixel test below documents exactly that; the
 * computed-style test documents what stays intact (selectors do not
 * pierce the shadow boundary).
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

const NEUTRAL_PORT = 3989;
const HOSTILE_PORT = 3990;

// Identical body markup on both hosts — the ONLY difference is the hostile
// <style> block. All three P7.3 vectors are present verbatim.
const BODY_MARKUP = `<main><h1 id="title">Hello</h1><button id="buy">Buy now</button></main>`;

const NEUTRAL_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Hostile host</title></head><body>${BODY_MARKUP}</body></html>`;

const HOSTILE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Hostile host</title>
<style>
  /* Vector 1 — global element rules. */
  * { all: unset; }
  button { background: red !important; color: white !important; border-radius: 0 !important; padding: 0 !important; }
  div { display: block !important; }
  * { font-family: "Comic Sans MS", "Comic Sans", cursive !important; font-size: 32px !important; }
  /* Vector 2 — our token names on :root (P7.1's set, self-contained). */
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
  /* Vector 3 — transitions and generated content.
     NOTE: a transform: scale(2) !important rule on * is deliberately NOT here.
     Measured (ticket P7.3): it is the only hostile vector that makes the pixel
     comparison fail, and it fails by GEOMETRY, not repaint — the probe's clip
     region came back uniform white because the host page scaled the overlay's
     own container, which is an element the host document owns. A shadow
     boundary cannot prevent a host from transforming a box it contains, and
     claiming it could would be false. The all: unset rule (also a layout
     vector) is kept and passes. The transform is covered by the third test,
     asserts the overlay's INTERNAL computed styles are unchanged under it. */
  * { transition: none !important; }
  *::before, *::after { content: "X" !important; }
</style>
</head><body>${BODY_MARKUP}</body></html>`;

/**
 * The geometric vector on its own: the host page scales everything it contains,
 * including the overlay's container. This page backs the third test, which
 * asserts the guarantee that actually exists — the overlay's internal computed
 * styles are unchanged (only the host's transform differs).
 */
const HOSTILE_GEOMETRY_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Hostile host (geometry)</title>
<style>
  * { all: unset; }
  * { transform: scale(2) !important; }
</style>
</head><body>${BODY_MARKUP}</body></html>`;

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  // The agent-chat trigger is the always-visible canary (flag-gated:
  // VIBEFLOW_FEATURES=CHAT in beforeAll). It is a <button>, so it is also
  // the direct target the hostile `button { ... !important }` rule would
  // repaint if outer selectors pierced the shadow boundary.
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

/**
 * Inject an opaque square probe painted only by overlay.css classes.
 * Inline style carries position/size/corner geometry alone — every painted
 * pixel (backgrounds, borders, shadows) resolves from the shadow
 * stylesheets under attack. Text-free so host-level font inheritance
 * (vector 1: 32px Comic Sans !important on the host, which the shadow
 * cannot override) cannot enter the paint; square (`border-radius: 0`) so
 * the repainted outer page cannot leak through transparent rounded
 * corners.
 */
async function injectProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    const root = host?.shadowRoot;
    if (!root) return;
    if (root.querySelector('[data-testid="hostile-css-probe"]')) return;
    const probe = document.createElement("div");
    probe.setAttribute("data-testid", "hostile-css-probe");
    probe.setAttribute(
      "style",
      "position:fixed;left:420px;top:220px;width:240px;height:140px;border-radius:0;",
    );
    probe.setAttribute("class", "vibeflow-popover");
    const header = document.createElement("div");
    header.setAttribute("class", "popover-header");
    const swatch = document.createElement("div");
    swatch.setAttribute(
      "style",
      "width:48px;height:48px;border-radius:0;background:#1e3a5f;",
    );
    header.appendChild(swatch);
    probe.appendChild(header);
    root.appendChild(probe);
  });
}

async function probeBox(page: Page): Promise<Region> {
  const box = await page.evaluate(() => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    const el = host?.shadowRoot?.querySelector(
      '[data-testid="hostile-css-probe"]',
    ) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) throw new Error("hostile-css probe missing from shadow root");
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

async function regionShot(page: Page, clip: Region): Promise<Buffer> {
  return page.screenshot({ clip });
}

async function triggerStyle(page: Page, prop: string): Promise<string> {
  return page.evaluate((p) => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    const el = host?.shadowRoot?.querySelector(
      '[data-testid="chat-trigger"]',
    ) as HTMLElement | null;
    if (!el) return "missing";
    return getComputedStyle(el).getPropertyValue(p).trim();
  }, prop);
}

async function probeHeaderDisplay(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    const el = host?.shadowRoot?.querySelector(
      '[data-testid="hostile-css-probe"] .popover-header',
    ) as HTMLElement | null;
    if (!el) return "missing";
    return getComputedStyle(el).display;
  });
}

describe("Overlay hostile-host-CSS zero-visual-change guard (P7.3)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let tempDir: string;
  let neutralInstance: ServeInstance;
  let hostileInstance: ServeInstance;
  let guard: ErrorGuard;

  beforeAll(async () => {
    process.env.VIBEFLOW_FEATURES = "CHAT";
    tempDir = mkdtempSync(join(tmpdir(), "vf-hostile-css-pw-"));
    const neutralDir = join(tempDir, "neutral");
    const hostileDir = join(tempDir, "hostile");
    mkdirSync(neutralDir);
    mkdirSync(hostileDir);
    writeFileSync(join(neutralDir, "index.html"), NEUTRAL_HTML);
    writeFileSync(join(hostileDir, "index.html"), HOSTILE_HTML);
    writeFileSync(join(hostileDir, "geometry.html"), HOSTILE_GEOMETRY_HTML);
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

  it("renders pixel-identical shadow paint on clean and hostile hosts", async () => {
    const neutral = await context.newPage();
    let clip: Region;
    let neutralShot: Buffer;
    try {
      await neutral.goto(`http://localhost:${NEUTRAL_PORT}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(neutral);
      await injectProbe(neutral);
      clip = await probeBox(neutral);
      neutralShot = await regionShot(neutral, clip);
    } finally {
      await neutral.close();
    }
    const hostile = await context.newPage();
    try {
      await hostile.goto(`http://localhost:${HOSTILE_PORT}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(hostile);
      await injectProbe(hostile);
      const hostileShot = await regionShot(hostile, clip);
      expect(hostileShot.equals(neutralShot)).toBe(true);
    } finally {
      await hostile.close();
    }
  });

  it("outer !important element rules do not win inside the shadow root", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${HOSTILE_PORT}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(page);
      await injectProbe(page);
      // The trigger is a <button>: a pierced boundary would paint it
      // hostile red / white / square.
      expect(await triggerStyle(page, "background-color")).toBe(
        "rgb(5, 13, 26)",
      );
      expect(await triggerStyle(page, "border-radius")).toBe("50%");
      expect(await triggerStyle(page, "color")).toBe("rgb(37, 99, 235)");
      // The probe header is a <div> with overlay `display: flex`: a pierced
      // boundary would collapse it to the hostile `div { display: block }`.
      expect(await probeHeaderDisplay(page)).toBe("flex");
    } finally {
      await page.close();
    }
  });

  it("a host-level transform repositions the overlay without repainting it", async () => {
    // The guarantee has an edge, and this test names it instead of pretending
    // it does not exist: a host page can scale the box it contains (measured —
    // that vector is the only one that breaks a pixel-identical assertion), but
    // it cannot change a single computed value inside the shadow root.
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${HOSTILE_PORT}/geometry.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(page);
      await injectProbe(page);
      expect(await triggerStyle(page, "background-color")).toBe(
        "rgb(5, 13, 26)",
      );
      expect(await triggerStyle(page, "border-radius")).toBe("50%");
      expect(await triggerStyle(page, "color")).toBe("rgb(37, 99, 235)");
      expect(await probeHeaderDisplay(page)).toBe("flex");
    } finally {
      await page.close();
    }
  });
});
