/**
 * Playwright e2e test: Overlay + ui-prototyping integration
 *
 * Uses the ACTUAL @vibeflow-tools/ui-prototyping VariantDevToolbar component
 * (bundled with esbuild at test setup time, React loaded via import maps).
 *
 * Scenario:
 *  1. Page loads with the real VariantDevToolbar rendered
 *  2. User injects Vibeflow overlay via bookmarklet (after page load)
 *  3. Assert: prototype button disappears, overlay corner trigger appears
 *  4. Assert: right-click on corner trigger shows context menu with "Prototyping"
 *  5. Assert: clicking "Prototyping" opens the variant panel via __vf_prototyping API
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import express from "express";
import { createServer } from "node:http";
import { serve } from "../../src/server/server.js";
import { getOverlayScript } from "../../src/client/overlay/index.js";
import type { ServeInstance } from "../../src/server/server.js";

// ── Ports ─────────────────────────────────────────────────────────────────────
const APP_PORT = 3895;
const API_PORT = 3896;
const APP_BASE = `http://localhost:${APP_PORT}`;

// ── Build a self-contained bundle of ui-prototyping ───────────────────────────
// esbuild bundles everything except React (external). React is loaded via a
// regular <script> tag and the import map resolves "react" → shim module.
function buildPrototypeBundle(outDir: string): string {
  // Navigate from tests/playwright/ up to the monorepo root
  const testDir = import.meta.dirname; // .../packages/cli/tests/playwright
  const projectRoot = join(testDir, "..", "..", "..", ".."); // .../vibeflow (monorepo root)
  const srcEntry = join(projectRoot, "packages/ui-prototyping/src/index.ts");
  const outFile = join(outDir, "prototype-bundle.js");

  execSync(
    `npx esbuild "${srcEntry}" --bundle --format=esm --platform=browser ` +
    `--outfile="${outFile}" ` +
    `--external:react --external:react/jsx-runtime ` +
    `--define:process.env.NODE_ENV=\\"test\\" ` +
    `--target=es2020`,
    { cwd: projectRoot, stdio: "pipe" },
  );

  return outFile;
}

// ── HTML page that renders the real VariantDevToolbar ─────────────────────────
function makePrototypeHTML(bundleUrl: string, shimUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Prototype App</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; background: #f8fafc; }
  </style>
  <!-- Import map: resolve bare "react" and "react/jsx-runtime" specifiers -->
  <script type="importmap">
  {
    "imports": {
      "react": "${shimUrl}/react.js",
      "react/jsx-runtime": "${shimUrl}/jsx-runtime.js"
    }
  }
  </script>
</head>
<body>
  <h1>Prototype App</h1>
  <p>This page has the real VariantDevToolbar from @vibeflow-tools/ui-prototyping.</p>
  <div id="root"></div>

  <!-- Load React as a global (UMD) — the shim modules re-export from this -->
  <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>

  <!-- Load the real ui-prototyping bundle via module (import map resolves react) -->
  <script type="module">
    import { VariantProvider, VariantDevToolbar } from '${bundleUrl}';

    const { createElement: h } = React;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(
      h(VariantProvider, null,
        h(VariantDevToolbar)
      )
    );
  </script>
</body>
</html>`;
}

// ── Shadow DOM helpers ────────────────────────────────────────────────────────
async function shadowExists(page: Page, sel: string): Promise<boolean> {
  return page.evaluate((s) => {
    const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
    return !!(host?.shadowRoot?.querySelector(s));
  }, sel);
}

async function shadowClick(page: Page, sel: string): Promise<void> {
  await page.evaluate((s) => {
    const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
    (host?.shadowRoot?.querySelector(s) as HTMLElement)?.click();
  }, sel);
}

async function waitForShadowRoot(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot,
    { timeout: 10_000 },
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe("Overlay + ui-prototyping integration (bookmarklet scenario)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let apiInstance: ServeInstance;
  let appServer: ReturnType<typeof createServer>;
  let prototypeBundlePath: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-integration-pw-"));

    // Build the prototype bundle
    prototypeBundlePath = buildPrototypeBundle(tempDir);

    // ── Start the "existing app" HTTP server ──────────────────────────────
    const appExpress = express();

    // Serve the prototype bundle as a module
    appExpress.get("/prototype-bundle.js", (_req, res) => {
      res.type("application/javascript").sendFile(prototypeBundlePath);
    });

    // Serve React shim modules that re-export from window.React
    appExpress.get("/shim/react.js", (_req, res) => {
      res.type("application/javascript").send(
        `const R = window.React;
export default R;
export const { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, createElement, Fragment, forwardRef, memo, lazy, Suspense, Children, cloneElement, isValidElement, startTransition, useTransition, useDeferredValue, useId, useSyncExternalStore, useInsertionEffect, useImperativeHandle, useDebugValue, cache, PureComponent, Component } = R;
`,
      );
    });
    appExpress.get("/shim/jsx-runtime.js", (_req, res) => {
      res.type("application/javascript").send(
        `const R = window.React;
export const jsx = R.jsx || R.createElement;
export const jsxs = R.jsxs || R.createElement;
export const Fragment = R.Fragment;
`,
      );
    });

    // Serve the HTML page
    appExpress.get("/", (_req, res) => {
      const html = makePrototypeHTML(
        `http://localhost:${APP_PORT}/prototype-bundle.js`,
        `http://localhost:${APP_PORT}/shim`,
      );
      res.type("html").send(html);
    });

    appServer = createServer(appExpress);
    await new Promise<void>((r) => appServer.listen(APP_PORT, r));

    // ── Start the Vibeflow Studio API server ──────────────────────────────
    apiInstance = await serve(undefined, { port: API_PORT, open: false, projectDir: tempDir });

    // ── Launch browser ────────────────────────────────────────────────────
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[browser] ${msg.text()}`);
      }
    });

    // Load the prototype page (overlay NOT injected yet)
    await page.goto(APP_BASE);

    // Wait for React to mount and VariantDevToolbar to render
    await page.waitForFunction(
      () => !!document.querySelector('[aria-label="Toggle variant dev toolbar"]'),
      { timeout: 15_000 },
    );
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await apiInstance?.close();
    await new Promise<void>((r) => appServer.close(() => r()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Phase 1: Before overlay injection ────────────────────────────────────
  it("real VariantDevToolbar button is visible before overlay injection", async () => {
    const visible = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="Toggle variant dev toolbar"]') as HTMLElement;
      if (!btn) return false;
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    expect(visible).toBe(true);
  });

  it("no overlay shadow root exists yet", async () => {
    const hasRoot = await page.evaluate(() => !!document.getElementById("vibeflow-studio-root"));
    expect(hasRoot).toBe(false);
  });

  it("clicking the button opens the variant panel", async () => {
    await page.click('[aria-label="Toggle variant dev toolbar"]');
    const panelExists = await page.evaluate(() => {
      return !!document.querySelector('[role="dialog"][aria-label="Variant dev toolbar"]');
    });
    expect(panelExists).toBe(true);
    // Close it
    await page.click('[aria-label="Close toolbar"]');
  });

  // ── Phase 2: Inject overlay (simulating bookmarklet) ─────────────────────
  it("overlay injects successfully after page load", async () => {
    const overlayScript = getOverlayScript(API_PORT);
    await page.evaluate((script) => {
      const s = document.createElement("script");
      s.textContent = script;
      document.head.appendChild(s);
    }, overlayScript);

    await waitForShadowRoot(page);

    const mode = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return host?.shadowRoot?.mode;
    });
    expect(mode).toBe("open");
  });

  // ── Phase 3: Verify integration ──────────────────────────────────────────
  it("overlay corner trigger is visible inside shadow DOM", async () => {
    const hasTrigger = await shadowExists(page, ".vibeflow-corner-trigger");
    expect(hasTrigger).toBe(true);
  });

  it("prototype button hides after overlay is detected", async () => {
    // Wait for the real VariantDevToolbar's MutationObserver/polling to detect the overlay
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[aria-label="Toggle variant dev toolbar"]') as HTMLElement;
        if (!btn) return true;
        return btn.offsetParent === null;
      },
      { timeout: 5_000 },
    );

    const hidden = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="Toggle variant dev toolbar"]') as HTMLElement;
      if (!btn) return true;
      return btn.offsetParent === null;
    });
    expect(hidden).toBe(true);
  });

  it("only one icon is visible — overlay in shadow DOM, prototype button hidden", async () => {
    const protoVisible = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="Toggle variant dev toolbar"]') as HTMLElement;
      if (!btn) return false;
      return btn.offsetParent !== null;
    });
    expect(protoVisible).toBe(false);

    const hasTrigger = await shadowExists(page, ".vibeflow-corner-trigger");
    expect(hasTrigger).toBe(true);
  });

  // ── Phase 4: Context menu integration ────────────────────────────────────
  it("right-clicking overlay corner trigger shows context menu", async () => {
    const triggerPos = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const trigger = host?.shadowRoot?.querySelector(".vibeflow-corner-trigger") as HTMLElement;
      if (!trigger) return null;
      const rect = trigger.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    expect(triggerPos).not.toBeNull();

    await page.mouse.click(triggerPos!.x, triggerPos!.y, { button: "right" });

    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return !!host?.shadowRoot?.querySelector(".vibeflow-trigger-ctx-menu");
      },
      { timeout: 5_000 },
    );

    const menuVisible = await shadowExists(page, ".vibeflow-trigger-ctx-menu");
    expect(menuVisible).toBe(true);
  });

  it("context menu contains 'Prototyping' option when __vf_prototyping is registered", async () => {
    const menuItems = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const menu = host?.shadowRoot?.querySelector(".vibeflow-trigger-ctx-menu");
      if (!menu) return [];
      const buttons = menu.querySelectorAll("button");
      return Array.from(buttons).map((b) => b.textContent?.trim() ?? "");
    });

    expect(menuItems).toContain("Prototyping");
    expect(menuItems).toContain("Hide Vibeflow");
  });

  it("clicking 'Prototyping' opens the variant panel via __vf_prototyping API", async () => {
    // Close any open menu first
    await page.mouse.click(10, 10);
    await page.waitForTimeout(100);

    // Re-open context menu
    const triggerPos = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const trigger = host?.shadowRoot?.querySelector(".vibeflow-corner-trigger") as HTMLElement;
      if (!trigger) return null;
      const rect = trigger.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(triggerPos!.x, triggerPos!.y, { button: "right" });

    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return !!host?.shadowRoot?.querySelector(".vibeflow-trigger-ctx-menu");
      },
      { timeout: 5_000 },
    );

    // Click "Prototyping" (first button in menu)
    await shadowClick(page, ".vibeflow-trigger-ctx-menu button:first-child");

    await page.waitForTimeout(300);

    // Verify the real VariantDevToolbar panel opened
    const panelOpen = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"][aria-label="Variant dev toolbar"]');
      return !!panel;
    });
    expect(panelOpen).toBe(true);
  });

  it("__vf_prototyping API reflects correct isOpen state", async () => {
    const apiState = await page.evaluate(() => {
      const api = (window as any).__vf_prototyping;
      if (!api) return null;
      return { isOpen: api.isOpen, hasOpenPanel: typeof api.openPanel === "function" };
    });
    expect(apiState).not.toBeNull();
    expect(apiState!.hasOpenPanel).toBe(true);
    expect(apiState!.isOpen).toBe(true);
  });

  it("closing the variant panel updates isOpen", async () => {
    await page.evaluate(() => {
      (window as any).__vf_prototyping?.closePanel();
    });
    const isOpen = await page.evaluate(() => (window as any).__vf_prototyping?.isOpen);
    expect(isOpen).toBe(false);
  });

  // ── Regression: overlay button must be visible even when localStorage has trigger-hidden=1 ──────
  it("corner trigger is visible on fresh bookmarklet injection even when localStorage has trigger-hidden=1", async () => {
    // Reproduces the bug: bookmarklet injection on a page where a prior "Hide Vibeflow"
    // action left vibeflow-trigger-hidden='1' in localStorage caused the corner trigger
    // to be permanently invisible. The fix: fresh injection always resets the hidden state.
    const freshPage = await context.newPage();

    // Pre-set the hidden state BEFORE the page loads — simulates a prior "Hide Vibeflow" action.
    await freshPage.addInitScript(() => {
      window.localStorage.setItem("vibeflow-trigger-hidden", "1");
    });

    // Navigate to the prototype app (overlay not yet injected)
    await freshPage.goto(APP_BASE);

    // Wait for the page to fully load
    await freshPage.waitForFunction(
      () => !!document.querySelector('[aria-label="Toggle variant dev toolbar"]'),
      { timeout: 15_000 },
    );

    // Inject the overlay via bookmarklet simulation (inline script, as bookmarklet does)
    const overlayScript = getOverlayScript(API_PORT);
    await freshPage.evaluate((script) => {
      const s = document.createElement("script");
      s.textContent = script;
      document.head.appendChild(s);
    }, overlayScript);

    // Wait for shadow root to mount
    await freshPage.waitForFunction(
      () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot,
      { timeout: 10_000 },
    );

    // Corner trigger MUST be visible despite localStorage having trigger-hidden='1'
    const hasTrigger = await freshPage.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!(host?.shadowRoot?.querySelector(".vibeflow-corner-trigger"));
    });

    expect(hasTrigger).toBe(true);
    await freshPage.close();
  });
});
