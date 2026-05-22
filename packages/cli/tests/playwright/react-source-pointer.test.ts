/**
 * Playwright e2e tests: React source pointer (line numbers) in task files.
 *
 * Tests that when a React app is annotated, the task .md file gets
 * file/line/col/component populated from the React fiber's _debugSource.
 *
 * React's dev-mode JSX transform sets _debugSource on every fiber node:
 *   el.__reactFiber$xxx = { _debugSource: { fileName, lineNumber, columnNumber } }
 *
 * We simulate this by injecting fake fiber keys onto the DOM elements, then
 * annotating via right-click → Annotate → Save, and asserting the saved task
 * markdown contains the expected source metadata.
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

const APP_PORT = 3895;
const API_PORT = 3896;
const APP_BASE = `http://localhost:${APP_PORT}`;

// ── A simulated React app page (plain HTML, no real React bundler needed) ────
//
// We attach a fake React fiber to DOM elements via inline script so the overlay's
// getReactSource() picks them up — exactly as a real React dev-mode build would.
const REACT_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>React App (simulated)</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; background: #f0f4f8; }
    button { padding: 10px 20px; background: #2563eb; color: white; border: none;
             border-radius: 6px; cursor: pointer; font-size: 16px; }
    .card { padding: 16px; border: 1px solid #cbd5e1; border-radius: 8px; margin: 16px 0; }
  </style>
</head>
<body>
  <div id="app-root">
    <h1 id="page-title">React Simulated App</h1>
    <button id="submit-btn">Submit</button>
    <div id="feature-card" class="card">Feature Card</div>
  </div>

  <script>
    // Simulate React dev-mode fiber keys on DOM elements.
    // Vibeflow Studio's getReactSource() searches for keys starting with
    // "__reactFiber" or "__reactInternalInstance".
    (function attachFakeReactFibers() {
      function attachFiber(el, fileName, lineNumber, columnNumber, componentName) {
        const fiberKey = '__reactFiber$fakeSuffix';
        el[fiberKey] = {
          _debugSource: { fileName, lineNumber, columnNumber },
          _debugOwner: { type: { displayName: componentName } },
          return: null,
        };
      }

      window.addEventListener('DOMContentLoaded', function() {
        attachFiber(
          document.getElementById('submit-btn'),
          '/src/components/SubmitButton.tsx',
          42,
          7,
          'SubmitButton'
        );
        attachFiber(
          document.getElementById('feature-card'),
          '/src/components/FeatureCard.tsx',
          18,
          3,
          'FeatureCard'
        );
        attachFiber(
          document.getElementById('page-title'),
          '/src/pages/HomePage.tsx',
          12,
          5,
          'HomePage'
        );
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

async function shadowSetReactInputValue(page: Page, sel: string, value: string): Promise<void> {
  await page.evaluate(
    ([s, v]) => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const el = host?.shadowRoot?.querySelector(s) as HTMLInputElement | null;
      if (!el) return;

      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
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
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const task = readTaskFiles(tempDir).find((entry) => entry.title === title);
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return readTaskFiles(tempDir).find((entry) => entry.title === title);
}

// ── Test suite ────────────────────────────────────────────────────────────────
describe("React source pointer — line numbers persisted in task files", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let apiInstance: ServeInstance;
  let appServer: ReturnType<typeof createServer>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-react-source-pw-"));

    // ── Start Vibeflow Studio API-only server ────────────────────────────────
    // Must start before the app server so the overlay script is available when
    // the browser loads the page.
    apiInstance = await serve(undefined, { port: API_PORT, open: false, projectDir: tempDir });

    // ── Start simulated React app server ─────────────────────────────────
    // Inject the overlay via <script src> so document.currentScript.src resolves
    // to the API origin (port API_PORT), making _vfOrigin point to the right server.
    const appExpress = express();
    appExpress.get("/", (_req, res) => {
      const html = REACT_APP_HTML.replace(
        "</body>",
        `<script src="http://localhost:${API_PORT}/vibeflow-overlay.js" data-vibeflow-overlay></script></body>`,
      );
      res.type("html").send(html);
    });
    appServer = createServer(appExpress);
    await new Promise<void>((r) => appServer.listen(APP_PORT, r));

    // ── Launch browser ────────────────────────────────────────────────────
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    await page.goto(APP_BASE);
    await waitForShadowRoot(page);

    // Wait for DOMContentLoaded to run (fake fibers are attached there)
    await page.waitForFunction(() => {
      const btn = document.getElementById("submit-btn");
      return btn && Object.keys(btn).some(k => k.startsWith("__reactFiber"));
    }, { timeout: 5_000 });
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await apiInstance?.close();
    await new Promise<void>((r) => appServer.close(() => r()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("overlay mounts on the React app page", async () => {
    const mode = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return host?.shadowRoot?.mode;
    });
    expect(mode).toBe("open");
  });

  it("React fiber is attached to #submit-btn (precondition)", async () => {
    const hasFiber = await page.evaluate(() => {
      const btn = document.getElementById("submit-btn");
      return btn ? Object.keys(btn).some(k => k.startsWith("__reactFiber")) : false;
    });
    expect(hasFiber).toBe(true);
  });

  it("getReactSource resolves file and line from the fake fiber", async () => {
    const result = await page.evaluate(() => {
      // Reproduce the getReactSource logic from selectors.ts inside the page
      const el = document.getElementById("submit-btn")!;
      const fiberKey = Object.keys(el).find(
        k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
      );
      if (!fiberKey) return null;
      let fiber: any = (el as any)[fiberKey];
      while (fiber) {
        if (fiber._debugSource) {
          return {
            file: fiber._debugSource.fileName,
            line: fiber._debugSource.lineNumber,
            col: fiber._debugSource.columnNumber,
          };
        }
        fiber = fiber.return;
      }
      return null;
    });
    expect(result).not.toBeNull();
    expect(result?.file).toBe("/src/components/SubmitButton.tsx");
    expect(result?.line).toBe(42);
    expect(result?.col).toBe(7);
  });

  it("annotating #submit-btn via right-click saves file/line/col/component in the task", async () => {
    // Right-click to open context menu
    await page.click("#submit-btn", { button: "right" });
    expect(await shadowExists(page, ".vibeflow-context-menu")).toBe(true);

    // Click "Annotate"
    await shadowClick(page, ".vibeflow-context-menu button:first-child");
    await page.waitForFunction(
      () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot?.querySelector(".vibeflow-popover"),
      { timeout: 5_000 },
    );

    // Fill in the task
    await shadowSetValue(page, ".vibeflow-popover input[type='text']", "Fix submit button styling");
    await shadowSetValue(page, ".vibeflow-popover textarea", "Button needs better contrast ratio");

    // Save
    await shadowClick(page, ".btn-primary");

    // Wait for the corner trigger flash (confirms task was saved)
    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return host?.shadowRoot?.querySelector(".vibeflow-corner-trigger")?.classList.contains("saved-flash");
      },
      { timeout: 8_000 },
    );

    const submitTask = await waitForSavedTask(tempDir, "Fix submit button styling");
    expect(submitTask).toBeDefined();

    expect(submitTask?.file).toBe("/src/components/SubmitButton.tsx");
    expect(submitTask?.line).toBe(42);
    expect(submitTask?.col).toBe(7);
    expect(submitTask?.component).toContain("SubmitButton");
  });

  it("annotating #feature-card saves its fiber source (file/line/col/component)", async () => {
    await page.keyboard.press("Escape"); // reset any lingering state

    await page.click("#feature-card", { button: "right" });
    expect(await shadowExists(page, ".vibeflow-context-menu")).toBe(true);

    await shadowClick(page, ".vibeflow-context-menu button:first-child");
    await page.waitForFunction(
      () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot?.querySelector(".vibeflow-popover"),
      { timeout: 5_000 },
    );

    await shadowSetValue(page, ".vibeflow-popover input[type='text']", "Feature card refactor");
    await shadowSetValue(page, ".vibeflow-popover textarea", "Extract to separate component");
    await shadowClick(page, ".btn-primary");

    await page.waitForFunction(
      () => {
        const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
        return host?.shadowRoot?.querySelector(".vibeflow-corner-trigger")?.classList.contains("saved-flash");
      },
      { timeout: 8_000 },
    );

    const card = await waitForSavedTask(tempDir, "Feature card refactor");
    expect(card).toBeDefined();
    expect(card?.file).toBe("/src/components/FeatureCard.tsx");
    expect(card?.line).toBe(18);
    expect(card?.col).toBe(3);
    expect(card?.component).toContain("FeatureCard");
  });

  it("task without a React fiber has no file/line/col in saved file", async () => {
    // Submit a task via the overlay API directly (no element association → no React source info).
    // The sidebar add-button that used to trigger this path was removed; direct API POST
    // is equivalent and keeps this contract verified.
    const apiBase = `http://localhost:${API_PORT}`;
    const ok = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "General task no source",
          description: "No fiber element",
          selector: "#app-root",
          status: "todo",
        }),
      });
      return r.ok;
    }, apiBase);
    expect(ok).toBe(true);

    const generalTask = await waitForSavedTask(tempDir, "General task no source");
    expect(generalTask).toBeDefined();
    expect(generalTask?.file).toBeUndefined();
    expect(generalTask?.line).toBeUndefined();
    expect(generalTask?.component).toBeUndefined();
  });
});
