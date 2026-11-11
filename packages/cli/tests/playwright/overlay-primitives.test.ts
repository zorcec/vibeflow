/**
 * Playwright test for overlay utility-subset isolation (ticket P7.2).
 *
 * The overlay's shadow root carries no Tailwind utilities (overlay.css is
 * hand-written), so a shared primitive styled with utilities — e.g.
 * cn("px-4", "px-6"), a `flex gap-2` container, a `rounded-lg` chip — would
 * render unstyled there. gen-overlay-css.mjs therefore compiles the
 * primitives' utility subset (same Tailwind v4 pipeline as the board,
 * content restricted to the files the overlay actually renders) into
 * OVERLAY_UTIL_CSS, and overlay-browser/ui.ts injects it as a second
 * <style> inside the shadow root.
 *
 * This spec proves it: on a hostile host whose outer stylesheet redefines
 * the same class names with loudly wrong values (which must NOT leak
 * through the shadow boundary) and which loads no Tailwind of its own,
 * probe elements created dynamically inside the shadow root resolve the
 * utilities to their real values — padding-left 24px (the cn merge keeps
 * only px-6), display flex with an 8px gap, an 8px border radius, and the
 * token-bound accent background. A pixel comparison of a utility-styled
 * chip against an unstyled same-size box proves the paint actually
 * changes, not just the computed values.
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import { cn } from "@vibeflow-tools/ui/primitives";

const PORT = 3988;

// The outer document redefines the SAME class names with loudly wrong
// values and loads no Tailwind: any correct resolution inside the shadow
// root must come from the injected subset, never from the host page.
const HOSTILE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Utility host</title>
<style>
  .px-6 { padding-left: 0 !important; padding-right: 0 !important; }
  .flex { display: block !important; }
  .gap-2 { gap: 0 !important; }
  .rounded-lg { border-radius: 0 !important; }
  .bg-accent { background-color: #000 !important; }
</style>
</head><body><main><h1 id="title">Hello</h1><button id="buy">Buy now</button></main></body></html>`;

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
  await page.waitForFunction(
    () =>
      document.querySelector(
        "#vibeflow-studio-root",
      )?.shadowRoot?.querySelector(".vibeflow-react-root") != null,
    undefined,
    { timeout: 15_000 },
  );
}

interface ProbeStyles {
  padLeft: string;
  padRight: string;
  display: string;
  gap: string;
  radius: string;
  chipBg: string;
}

async function probeStyles(page: Page, padClass: string): Promise<ProbeStyles> {
  return page.evaluate((cls) => {
    const host = document.querySelector(
      "#vibeflow-studio-root",
    ) as HTMLElement | null;
    const root = host?.shadowRoot;
    if (!root) return {} as never;
    let probe = root.querySelector('[data-testid="primitive-probe"]');
    if (!probe) {
      probe = document.createElement("div");
      probe.setAttribute("data-testid", "primitive-probe");
      // Opaque backdrop: element screenshots crop the viewport, so host-page
      // paint behind the transparent boxes would confound the pixel
      // comparison. With the backdrop, chip and plain are byte-identical
      // unless the subset paints the chip.
      probe.setAttribute("style", "background-color: #111111");
      probe.innerHTML =
        `<div data-part="pad" class="${cls}"></div>` +
        `<div data-part="row" class="flex gap-2"><span>a</span><span>b</span></div>` +
        `<div data-part="chip" class="rounded-lg bg-accent" style="width:64px;height:32px"></div>` +
        `<div data-part="plain" style="width:64px;height:32px"></div>`;
      root.appendChild(probe);
    }
    const q = (part: string) =>
      probe!.querySelector(`[data-part="${part}"]`) as HTMLElement;
    const cs = (el: HTMLElement) => getComputedStyle(el);
    return {
      padLeft: cs(q("pad")).paddingLeft,
      padRight: cs(q("pad")).paddingRight,
      display: cs(q("row")).display,
      gap: cs(q("row")).gap,
      radius: cs(q("chip")).borderRadius,
      chipBg: cs(q("chip")).backgroundColor,
    };
  }, padClass);
}

describe("Overlay utility subset isolation (P7.2)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let tempDir: string;
  let instance: ServeInstance;
  let guard: ErrorGuard;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "vf-util-subset-pw-"));
    writeFileSync(join(tempDir, "index.html"), HOSTILE_HTML);
    instance = await serve(tempDir, {
      port: PORT,
      open: false,
      quiet: true,
      projectDir: tempDir,
    } as never);
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    guard = guardContext(context);
  });

  afterEach(() => guard.assertNoErrors());

  afterAll(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await instance?.close().catch(() => {});
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("the cn primitive resolves conflicting utilities before they reach the shadow DOM", () => {
    expect(cn("px-4", "px-6")).toBe("px-6");
  });

  it("a primitive styled with utilities renders correctly inside the shadow root", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${PORT}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(page);
      const styles = await probeStyles(page, cn("px-4", "px-6"));
      // px-6 wins the cn merge: 6 * --spacing (0.25rem) = 24px, not the
      // hostile outer 0 and not a missing-utility fallback.
      expect(styles.padLeft).toBe("24px");
      expect(styles.padRight).toBe("24px");
      expect(styles.display).toBe("flex");
      expect(styles.gap).toBe("8px");
      expect(styles.radius).toBe("8px");
      // Token-bound utility: @theme inline keeps var(--t-accent), which
      // resolves against the :host block (--p-blue #2563eb).
      expect(styles.chipBg).toBe("rgb(37, 99, 235)");
    } finally {
      await page.close();
    }
  });

  it("the utilities change the painted pixels, not just computed values", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`http://localhost:${PORT}/index.html`, {
        waitUntil: "networkidle",
      });
      await waitForOverlay(page);
      await probeStyles(page, cn("px-4", "px-6"));
      // Playwright's CSS engine pierces the open shadow root, so these
      // locate the probe elements inside it. Both boxes are fixed to the
      // same size: without the subset the chip paints nothing (fully
      // transparent, byte-identical to the plain box); with it the chip
      // is a blue rounded rect.
      const chip = await page
        .locator('[data-testid="primitive-probe"] [data-part="chip"]')
        .screenshot();
      const plain = await page
        .locator('[data-testid="primitive-probe"] [data-part="plain"]')
        .screenshot();
      expect(chip.equals(plain)).toBe(false);
    } finally {
      await page.close();
    }
  });
});
