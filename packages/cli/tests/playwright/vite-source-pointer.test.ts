/**
 * Playwright e2e tests: Tier 2b — V8 direct source extraction for unbundled apps.
 *
 * Simulates a Vite dev-server app where modules are served as individual files
 * (no bundling). React 18+ stores _debugStack on fibers instead of _debugSource.
 * Stack frames in _debugStack contain real module URLs like:
 *   http://localhost:PORT/src/components/Button.tsx?v=abc123:42:7
 *
 * Tier 2b detects these as "direct source URLs" and extracts file:line:col
 * without fetching any .js.map file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { createServer } from "node:http";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const APP_PORT = 3905;
const API_PORT = 3906;
const APP_BASE = `http://localhost:${APP_PORT}`;

// ── A simulated Vite unbundled React 18+ page ─────────────────────────────────
//
// React 18.3+ dropped _debugSource. Instead it sets _debugStack = new Error()
// on fibers. In a real Vite dev server the stack frames point to module URLs
// like http://localhost:5173/src/components/Foo.tsx?v=abc123.
// We simulate this by injecting fibers whose _debugStack has a pre-set .stack
// string containing Vite-style URLs.
const VITE_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Vite Unbundled App (simulated)</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; background: #f9fafb; }
    button { padding: 10px 20px; background: #7c3aed; color: white; border: none;
             border-radius: 6px; cursor: pointer; font-size: 16px; }
    .card { padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; margin: 16px 0; }
  </style>
</head>
<body>
  <div id="app-root">
    <h1 id="page-title">Vite Simulated App</h1>
    <button id="checkout-btn">Checkout</button>
    <div id="product-card" class="card">Product Card</div>
    <div id="no-stack-elem" class="card">Element with no stack</div>
  </div>

  <script>
    // Simulate React 18+ fibers with _debugStack instead of _debugSource.
    // The _debugStack is an Error whose .stack contains Vite-style module URLs.
    (function attachViteFibers() {
      function makeDebugStack(componentName, filePath, line, col) {
        const err = new Error('react-stack-top-frame');
        // Vite dev-server URL format: host/path?v=hash:line:col
        err.stack = [
          'Error: react-stack-top-frame',
          '    at jsxDEV (http://localhost:5173/node_modules/react/cjs/react-jsx-dev-runtime.development.js:100:10)',
          '    at ' + componentName + ' (http://localhost:' + ${APP_PORT} + filePath + ':' + line + ':' + col + ')',
          '    at renderWithHooks (http://localhost:5173/node_modules/react-dom/cjs/react-dom.development.js:999:10)',
        ].join('\\n');
        return err;
      }

      function attachFiber(el, debugStack, componentName) {
        const fiberKey = '__reactFiber$viteSimulated';
        el[fiberKey] = {
          _debugStack: debugStack,
          _debugOwner: { type: { displayName: componentName } },
          return: null,
        };
      }

      window.addEventListener('DOMContentLoaded', function() {
        attachFiber(
          document.getElementById('checkout-btn'),
          makeDebugStack('CheckoutButton', '/src/components/CheckoutButton.tsx?v=abc123', 28, 5),
          'CheckoutButton'
        );
        attachFiber(
          document.getElementById('product-card'),
          makeDebugStack('ProductCard', '/src/components/ProductCard.tsx?v=def456', 15, 3),
          'ProductCard'
        );
        // no-stack-elem intentionally has no fiber attached
      });
    })();
  </script>
</body>
</html>`;

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

interface SavedTask {
  id: string;
  title: string;
  file?: string;
  line?: number;
  col?: number;
  component?: string;
}

function readTaskFiles(tempDir: string): SavedTask[] {
  const tasksDir = join(tempDir, ".vibeflow", "tasks");
  try {
    const results: SavedTask[] = [];
    for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const subDir = join(tasksDir, entry.name);
        for (const file of readdirSync(subDir).filter(f => f.endsWith(".json"))) {
          results.push(JSON.parse(readFileSync(join(subDir, file), "utf-8")) as SavedTask);
        }
      } else if (entry.name.endsWith(".json")) {
        results.push(JSON.parse(readFileSync(join(tasksDir, entry.name), "utf-8")) as SavedTask);
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function waitForSavedTask(tempDir: string, title: string, timeoutMs = 5_000): Promise<SavedTask | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = readTaskFiles(tempDir).find(t => t.title === title);
    if (task) return task;
    await new Promise(r => setTimeout(r, 100));
  }
  return readTaskFiles(tempDir).find(t => t.title === title);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Tier 2b — Vite unbundled source pointer (React 18+ _debugStack)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let apiInstance: ServeInstance;
  let appServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-vite-source-pw-"));

    // Must start before the app server so the overlay script is available when
    // the browser loads the page.
    apiInstance = await serve(undefined, { port: API_PORT, open: false, projectDir: tempDir });

    const appExpress = express();
    appExpress.get("/", (_req, res) => {
      const html = VITE_APP_HTML.replace(
        "</body>",
        `<script src="http://localhost:${API_PORT}/vibeflow-overlay.js" data-vibeflow-overlay></script></body>`,
      );
      res.type("html").send(html);
    });
    appServer = createServer(appExpress);
    await new Promise<void>(r => appServer.listen(APP_PORT, r));

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    await page.goto(APP_BASE);
    await waitForShadowRoot(page);

    await page.waitForFunction(() => {
      const btn = document.getElementById("checkout-btn");
      return btn && Object.keys(btn).some(k => k.startsWith("__reactFiber"));
    }, { timeout: 5_000 });
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await apiInstance?.close();
    await new Promise<void>(r => appServer.close(() => r()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("overlay mounts on the Vite simulated page", async () => {
    const mode = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return host?.shadowRoot?.mode;
    });
    expect(mode).toBe("open");
  });

  it("Vite-style fiber (_debugStack only) is attached to #checkout-btn", async () => {
    const hasFiber = await page.evaluate(() => {
      const btn = document.getElementById("checkout-btn");
      return btn ? Object.keys(btn).some(k => k.startsWith("__reactFiber")) : false;
    });
    expect(hasFiber).toBe(true);
  });

  it("_debugStack has no _debugSource (React 18+ unbundled precondition)", async () => {
    const hasDebugSource = await page.evaluate(() => {
      const btn = document.getElementById("checkout-btn");
      if (!btn) return true;
      const fiberKey = Object.keys(btn).find(k => k.startsWith("__reactFiber"));
      if (!fiberKey) return true;
      return !!(btn as any)[fiberKey]._debugSource;
    });
    expect(hasDebugSource).toBe(false);
  });

  it("Tier 2b resolveDirectSourceFromStack extracts file/line directly in browser", async () => {
    const result = await page.evaluate(() => {
      const el = document.getElementById("checkout-btn")!;
      const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber"));
      if (!fiberKey) return null;
      const fiber = (el as any)[fiberKey];
      const ds = fiber?._debugStack;
      if (!(ds instanceof Error)) return null;

      // Mirror the string-fallback logic from resolveDirectSourceFromStack
      const stack = typeof ds.stack === "string" ? ds.stack : null;
      if (!stack) return null;

      const SKIP = /node_modules|_next\/dist|react-stack-top-frame|jsxDEV|react_stack_bottom_frame/;
      const DIRECT = /\.m?[tj]sx?(\?[^)]*)?$/;
      const BUNDLE = /chunk[-_.][0-9a-f]{6,}|\.chunk\.[0-9a-f]|webpack|_next\/(?:static\/chunks|dist)|rollup/i;

      for (const raw of stack.split("\n")) {
        const m = raw.match(/^\s*at [^(]+ \(([^)]+):(\d+):(\d+)\)$/) ??
                  raw.match(/^\s*at ((?:https?|file):\/\/[^:]+):(\d+):(\d+)$/);
        if (!m) continue;
        const [, url, lineStr, colStr] = m;
        if (SKIP.test(url)) continue;
        if (!DIRECT.test(url)) continue;
        if (BUNDLE.test(url)) continue;
        return { url, line: parseInt(lineStr, 10), col: parseInt(colStr, 10) };
      }
      return null;
    });

    expect(result).not.toBeNull();
    expect(result?.url).toContain("CheckoutButton.tsx");
    expect(result?.line).toBe(28);
    expect(result?.col).toBe(5);
  });

  it("annotating #checkout-btn saves file/line from Vite _debugStack (Tier 2b)", async () => {
    await page.click("#checkout-btn", { button: "right" });
    expect(await shadowExists(page, ".vibeflow-context-menu")).toBe(true);

    await shadowClick(page, ".vibeflow-context-menu button:first-child");
    await page.waitForFunction(
      () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot?.querySelector(".vibeflow-popover"),
      { timeout: 5_000 },
    );

    await shadowSetValue(page, ".vibeflow-popover input[type='text']", "Fix checkout button alignment");
    await shadowSetValue(page, ".vibeflow-popover textarea", "Vite unbundled source test");
    await shadowClick(page, ".btn-primary");

    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return host?.shadowRoot?.querySelector(".vibeflow-corner-trigger")?.classList.contains("saved-flash");
      },
      { timeout: 8_000 },
    );

    const task = await waitForSavedTask(tempDir, "Fix checkout button alignment");
    expect(task).toBeDefined();
    // Tier 2b should have extracted file/line from the Vite _debugStack URL
    expect(task?.file).toContain("CheckoutButton.tsx");
    expect(task?.line).toBe(28);
    expect(task?.col).toBe(5);
    expect(task?.component).toContain("CheckoutButton");
  });

  it("annotating #product-card saves correct Vite source (Tier 2b)", async () => {
    await page.keyboard.press("Escape");
    await page.click("#product-card", { button: "right" });
    expect(await shadowExists(page, ".vibeflow-context-menu")).toBe(true);

    await shadowClick(page, ".vibeflow-context-menu button:first-child");
    await page.waitForFunction(
      () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot?.querySelector(".vibeflow-popover"),
      { timeout: 5_000 },
    );

    await shadowSetValue(page, ".vibeflow-popover input[type='text']", "Improve product card layout");
    await shadowSetValue(page, ".vibeflow-popover textarea", "Card needs responsive styling");
    await shadowClick(page, ".btn-primary");

    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return host?.shadowRoot?.querySelector(".vibeflow-corner-trigger")?.classList.contains("saved-flash");
      },
      { timeout: 8_000 },
    );

    const task = await waitForSavedTask(tempDir, "Improve product card layout");
    expect(task).toBeDefined();
    expect(task?.file).toContain("ProductCard.tsx");
    expect(task?.line).toBe(15);
    expect(task?.col).toBe(3);
    expect(task?.component).toContain("ProductCard");
  });

  it("element without _debugStack falls back to CSS selector gracefully", async () => {
    await page.keyboard.press("Escape");
    const apiBase = `http://localhost:${API_PORT}`;
    const ok = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Task from no-stack element",
          description: "No _debugStack on this element",
          selector: "#no-stack-elem",
          status: "todo",
        }),
      });
      return r.ok;
    }, apiBase);
    expect(ok).toBe(true);

    const task = await waitForSavedTask(tempDir, "Task from no-stack element");
    expect(task).toBeDefined();
    expect(task?.file).toBeUndefined();
    expect(task?.line).toBeUndefined();
  });
});
