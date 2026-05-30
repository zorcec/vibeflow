/**
 * Playwright e2e tests for the Vibeflow Studio overlay.
 *
 * These tests serve a real HTML page with a dark-theme host (mimicking Tailwind
 * pages with `color: white` on `*`) and verify that the Shadow DOM overlay is
 * fully visually isolated — correct dark theme colours everywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3880;
const BASE = `http://localhost:${PORT}`;

// ── Fixture HTML ─────────────────────────────────────────────────────────────
const DARK_THEME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Dark Theme Prototype</title>
  <style>
    *, *::before, *::after { color: white; background-color: #0f172a; box-sizing: border-box; }
    body                   { color: white; background: #0f172a; font-family: sans-serif; min-height: 100vh; }
    button, select, textarea, input {
      color: white;
      background: #1e293b;
      border: 1px solid #334155;
      padding: 8px;
    }
  </style>
</head>
<body>
  <nav   data-vibeflow-id="main-nav">Main Navigation</nav>
  <main  data-vibeflow-id="main-content">
    <h1  data-vibeflow-id="hero-title">Dark Theme Prototype</h1>
    <button data-vibeflow-id="cta-button">Primary Action</button>
    <section data-vibeflow-id="features-section">
      <h2 data-vibeflow-id="features-title">Features</h2>
      <form data-vibeflow-id="login-form">
        <input type="text"  placeholder="Username" data-vibeflow-id="username-input">
        <button type="submit" data-vibeflow-id="submit-btn">Login</button>
      </form>
    </section>
  </main>
</body>
</html>`;

// ── Colour helpers ────────────────────────────────────────────────────────────
function rgbAvg(css: string): number {
  const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return -1;
  return (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
}
function isLight(css: string)  { return rgbAvg(css) > 200; }
function isDark(css: string)   { return rgbAvg(css) < 100; }
function isBlue(css: string)   {
  const m = css.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return false;
  return Number(m[3]) > Number(m[1]);
}
function isOpaque(css: string) {
  return css !== "rgba(0, 0, 0, 0)" && css !== "transparent";
}

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

async function shadowStyle(page: Page, sel: string, prop: keyof CSSStyleDeclaration): Promise<string> {
  return page.evaluate(
    ([s, p]) => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const el = host?.shadowRoot?.querySelector(s) as HTMLElement;
      if (!el) return "rgba(0, 0, 0, 0)";
      return (getComputedStyle(el) as Record<string, string>)[p as string] ?? "";
    },
    [sel, prop as string],
  );
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
      if (el) {
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
    [sel, value],
  );
}

// ── Test suite ───────────────────────────────────────────────────────────────
describe("Overlay — Shadow DOM visual isolation on dark-theme host", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-pw-"));
    writeFileSync(join(tempDir, "index.html"), DARK_THEME_HTML, "utf-8");

    instance = await serve(join(tempDir, "index.html"), { port: PORT, open: false });
    browser  = await chromium.launch({ headless: true });
    context  = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page     = await context.newPage();

    await page.goto(BASE);
    await page.waitForFunction(
      () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot,
      { timeout: 10_000 },
    );
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Structural checks ───────────────────────────────────────────────────
  it("mounts a shadow DOM host with an open shadow root", async () => {
    const mode = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return host?.shadowRoot?.mode;
    });
    expect(mode).toBe("open");
  });

  it("injects overlay stylesheet inside the shadow root", async () => {
    const count = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return host?.shadowRoot?.querySelectorAll("style").length ?? 0;
    });
    expect(count).toBeGreaterThan(0);
  });

  it("renders the corner trigger toggle button inside the shadow DOM", async () => {
    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(true);
  });

  // ── Corner trigger colours (dark theme) ──────────────────────────────────
  it("corner trigger: has opaque blue background", async () => {
    const bg = await shadowStyle(page, ".vibeflow-corner-trigger", "backgroundColor");
    expect(isOpaque(bg)).toBe(true);
    expect(isBlue(bg)).toBe(true);
  });

  it("corner trigger: contains SVG icon", async () => {
    const hasSvg = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!(host?.shadowRoot?.querySelector(".vibeflow-corner-trigger svg"));
    });
    expect(hasSvg).toBe(true);
  });

  // ── Annotation mode ─────────────────────────────────────────────────────
  it("Alt+A enables annotation mode (adds class to body)", async () => {
    await page.keyboard.press("Alt+a");
    const active = await page.evaluate(() =>
      document.body.classList.contains("vibeflow-overlay-active"),
    );
    expect(active).toBe(true);
  });

  // ── Popover (dark theme) ────────────────────────────────────────────────
  it("clicking a data-vibeflow-id element opens the popover", async () => {
    await page.click('[data-vibeflow-id="cta-button"]');
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(true);
  });

  it("popover: dark background (dark theme)", async () => {
    const bg = await shadowStyle(page, ".vibeflow-popover", "backgroundColor");
    expect(isOpaque(bg)).toBe(true);
    expect(isDark(bg)).toBe(true);
  });

  it("popover: light text (dark theme)", async () => {
    const color = await shadowStyle(page, ".vibeflow-popover", "color");
    expect(isLight(color)).toBe(true);
  });

  it("popover label: shows the proto-id being annotated", async () => {
    const text = await shadowText(page, ".popover-target-name");
    expect(text).toContain("cta-button");
  });

  it("popover has title input and textarea", async () => {
    expect(await shadowExists(page, ".vibeflow-popover input[type='text']")).toBe(true);
    expect(await shadowExists(page, ".vibeflow-popover textarea")).toBe(true);
  });

  it("popover textarea: light text (dark theme)", async () => {
    const color = await shadowStyle(page, ".vibeflow-popover textarea", "color");
    expect(isLight(color)).toBe(true);
  });

  it("popover textarea: dark background", async () => {
    const bg = await shadowStyle(page, ".vibeflow-popover textarea", "backgroundColor");
    expect(isOpaque(bg)).toBe(true);
    expect(isDark(bg)).toBe(true);
  });

  it("popover save button: white text on blue background", async () => {
    const color = await shadowStyle(page, ".vibeflow-popover .btn-primary", "color");
    const bg    = await shadowStyle(page, ".vibeflow-popover .btn-primary", "backgroundColor");
    expect(isLight(color)).toBe(true);
    expect(isBlue(bg)).toBe(true);
  });

  it("popover has title input field", async () => {
    expect(await shadowExists(page, ".vibeflow-popover input[type='text']")).toBe(true);
  });

  // ── Escape behaviour ────────────────────────────────────────────────────
  it("Escape dismisses the popover", async () => {
    await page.keyboard.press("Escape");
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(false);
  });

  it("Escape deactivates annotation mode", async () => {
    await page.keyboard.press("Escape");
    const active = await page.evaluate(() =>
      document.body.classList.contains("vibeflow-overlay-active"),
    );
    expect(active).toBe(false);
  });

  // ── Task submission ──────────────────────────────────────────────────────
  it("submitting task shows saved-flash on corner trigger", async () => {
    await page.keyboard.press("Alt+a");
    await page.click('[data-vibeflow-id="hero-title"]');

    await shadowSetValue(page, ".vibeflow-popover input[type='text']", "Test task title");
    await shadowSetValue(page, ".vibeflow-popover textarea", "Shadow DOM test task");
    await shadowClick(page, ".btn-primary");

    // Corner trigger should briefly flash green (saved-flash class)
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

    // Wait for potential WS-triggered reload
    await Promise.race([
      page.waitForNavigation({ timeout: 4_000 }).catch(() => null),
      new Promise((r) => setTimeout(r, 4_000)),
    ]);
    await page.waitForFunction(
      () => !!(document.querySelector("#vibeflow-studio-root") as HTMLElement)?.shadowRoot,
      { timeout: 5_000 },
    );
    // Exit annotation mode (no-op if page reloaded and reset state)
    await page.keyboard.press("Escape");
  });

  // ── Corner trigger button ─────────────────────────────────────────────
  it("corner trigger button exists in shadow DOM", async () => {
    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(true);
  });

  it("can annotate a second element after the first was submitted", async () => {
    await page.keyboard.press("Alt+a");
    await page.click('[data-vibeflow-id="submit-btn"]');
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(true);

    const label = await shadowText(page, ".popover-target-name");
    expect(label).toContain("submit-btn");

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  // ── No popover outside annotation mode ───────────────────────────────────
  it("clicking a proto-id element outside annotation mode does NOT open popover", async () => {
    const active = await page.evaluate(() =>
      document.body.classList.contains("vibeflow-overlay-active"),
    );
    expect(active).toBe(false);

    await page.click('[data-vibeflow-id="cta-button"]');
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(false);
  });

  // ── Bug report: console errors are attached to description ─────────────────
  //
  // NOTE: Only the following are captured by the error-recorder:
  //   1. console.error() / console.warn() — patched at overlay init
  //   2. throw new Error() / uncaught errors — via window.onerror
  //   3. Unhandled promise rejections — via unhandledrejection event
  //
  //   "new Error('test')" alone in DevTools just creates an object and is NOT
  //   captured because nothing observable fires (no throw, no console.error).
  //   Users must use throw or console.error to trigger capture.
  //
  it("Bug type report includes captured console errors in task description", async () => {
    // Generate a distinctly identifiable console error before annotating
    const errorSignature = "VibeflowBugTest_" + Date.now();
    await page.evaluate((sig) => { console.error("Test error:", sig); }, errorSignature);

    // Enable annotation mode
    await page.keyboard.press("Alt+a");
    const modeActive = await page.evaluate(() => document.body.classList.contains("vibeflow-overlay-active"));
    expect(modeActive).toBe(true);

    // Click the CTA button to open the popover
    await page.click('[data-vibeflow-id="cta-button"]');
    const hasPopover = await shadowExists(page, ".vibeflow-popover");
    expect(hasPopover).toBe(true);

    // Change type to Bug by clicking the type picker trigger, then the Bug option
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const sr = host?.shadowRoot;
      if (!sr) return;
      const trigger = sr.querySelector(".type-picker-trigger") as HTMLElement;
      trigger?.click();
    });

    const bugOptionClicked = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const sr = host?.shadowRoot;
      if (!sr) return false;
      const options = sr.querySelectorAll(".type-picker-option");
      for (const opt of options) {
        // Options use title=tooltip; match by label text content instead
        const label = (opt as HTMLElement).querySelector(".type-picker-label")?.textContent?.trim();
        if (label === "Bug") {
          (opt as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    expect(bugOptionClicked).toBe(true);

    // Fill in a title
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const input = host?.shadowRoot?.querySelector(".vibeflow-popover input[type='text']") as HTMLInputElement;
      if (input) { input.value = "Bug regression test"; input.dispatchEvent(new Event("input", { bubbles: true })); }
    });

    // Submit the task
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const btn = host?.shadowRoot?.querySelector(".vibeflow-popover .btn-primary") as HTMLElement;
      btn?.click();
    });

    // Wait for the task to be saved (popover should close)
    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !host?.shadowRoot?.querySelector(".vibeflow-popover");
    }, { timeout: 5000 });

    // Disable annotation mode
    await page.keyboard.press("Alt+a");

    // Fetch the created task from the API and check the description
    const { tasks } = await fetch(`${BASE}/api/tasks`).then(r => r.json()) as { tasks: Array<{ title: string; description?: string }> };
    const bugTask = tasks.find((t) => t.title === "Bug regression test");
    expect(bugTask).toBeDefined();
    expect(bugTask?.description).toContain(errorSignature);
    expect(bugTask?.description).toContain("Console logs");
  });

  it("Bug type report captures window.onerror errors (throw new Error)", async () => {
    // Generate an uncaught error via window ErrorEvent — equivalent to `throw new Error(sig)`
    // firing on the page (e.g. from a script tag or setTimeout callback).
    // Using dispatchEvent directly is more reliable in headless Playwright than async throws.
    const throwSig = "VibeflowThrowTest_" + Date.now();
    await page.evaluate((sig) => {
      window.dispatchEvent(new ErrorEvent("error", {
        message: sig,
        error: new Error(sig),
        bubbles: true,
        cancelable: true,
      }));
    }, throwSig);

    // Enable annotation mode
    await page.keyboard.press("Alt+a");
    const modeActive2 = await page.evaluate(() => document.body.classList.contains("vibeflow-overlay-active"));
    expect(modeActive2).toBe(true);

    await page.click('[data-vibeflow-id="hero-title"]');
    expect(await shadowExists(page, ".vibeflow-popover")).toBe(true);

    // Select Bug type
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const trigger = host?.shadowRoot?.querySelector(".type-picker-trigger") as HTMLElement;
      trigger?.click();
    });
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const opts = host?.shadowRoot?.querySelectorAll(".type-picker-option");
      for (const opt of opts ?? []) {
        const label = (opt as HTMLElement).querySelector(".type-picker-label")?.textContent?.trim();
        if (label === "Bug") { (opt as HTMLElement).click(); break; }
      }
    });

    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const input = host?.shadowRoot?.querySelector(".vibeflow-popover input[type='text']") as HTMLInputElement;
      if (input) { input.value = "Bug throw test"; input.dispatchEvent(new Event("input", { bubbles: true })); }
    });
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      (host?.shadowRoot?.querySelector(".vibeflow-popover .btn-primary") as HTMLElement)?.click();
    });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !host?.shadowRoot?.querySelector(".vibeflow-popover");
    }, { timeout: 5000 });

    await page.keyboard.press("Alt+a"); // exit annotation mode

    const { tasks: allTasks } = await fetch(`${BASE}/api/tasks`).then(r => r.json()) as { tasks: Array<{ title: string; description?: string }> };
    const throwTask = allTasks.find((t) => t.title === "Bug throw test");
    expect(throwTask).toBeDefined();
    expect(throwTask?.description).toContain(throwSig);
    expect(throwTask?.description).toContain("Console logs");
  });

  // ── Hide / Show Vibeflow badge ─────────────────────────────────────────────
  it("right-clicking corner trigger shows Hide Vibeflow menu", async () => {
    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(true);

    // Get trigger position and right-click it
    const pos = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const trigger = host?.shadowRoot?.querySelector(".vibeflow-corner-trigger") as HTMLElement;
      const rect = trigger?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    });
    expect(pos).not.toBeNull();
    await page.mouse.click(pos!.x, pos!.y, { button: "right" });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!host?.shadowRoot?.querySelector(".vibeflow-trigger-ctx-menu");
    }, { timeout: 2000 });

    const hasHideBtn = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const menu = host?.shadowRoot?.querySelector(".vibeflow-trigger-ctx-menu");
      return Array.from(menu?.querySelectorAll("button") ?? [])
        .some((b) => b.textContent?.includes("Hide Vibeflow"));
    });
    expect(hasHideBtn).toBe(true);

    // Close context menu without hiding
    await page.keyboard.press("Escape");
    await page.click("body");
  });

  it("clicking Hide Vibeflow hides the corner trigger", async () => {
    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(true);

    const pos = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const trigger = host?.shadowRoot?.querySelector(".vibeflow-corner-trigger") as HTMLElement;
      const rect = trigger?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    });
    await page.mouse.click(pos!.x, pos!.y, { button: "right" });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!host?.shadowRoot?.querySelector(".vibeflow-trigger-ctx-menu");
    }, { timeout: 2000 });

    // Click "Hide Vibeflow"
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const menu = host?.shadowRoot?.querySelector(".vibeflow-trigger-ctx-menu");
      const btn = Array.from(menu?.querySelectorAll("button") ?? [])
        .find((b) => b.textContent?.includes("Hide Vibeflow")) as HTMLElement | undefined;
      btn?.click();
    });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !host?.shadowRoot?.querySelector(".vibeflow-corner-trigger");
    }, { timeout: 2000 });

    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(false);
  });

  it("right-clicking page element shows Show Vibeflow when badge is hidden", async () => {
    // Badge should be hidden from the previous test
    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(false);

    // Right-click a page element to get the page-level context menu
    await page.click('[data-vibeflow-id="main-nav"]', { button: "right" });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!host?.shadowRoot?.querySelector(".vibeflow-context-menu");
    }, { timeout: 2000 });

    const hasShowBtn = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const menu = host?.shadowRoot?.querySelector(".vibeflow-context-menu");
      return Array.from(menu?.querySelectorAll("button") ?? [])
        .some((b) => b.textContent?.includes("Show Vibeflow"));
    });
    expect(hasShowBtn).toBe(true);

    // Click "Show Vibeflow"
    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const menu = host?.shadowRoot?.querySelector(".vibeflow-context-menu");
      const btn = Array.from(menu?.querySelectorAll("button") ?? [])
        .find((b) => b.textContent?.includes("Show Vibeflow")) as HTMLElement | undefined;
      btn?.click();
    });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!host?.shadowRoot?.querySelector(".vibeflow-corner-trigger");
    }, { timeout: 2000 });

    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(true);
  });

  it("right-clicking page element shows Hide Vibeflow when badge is visible", async () => {
    // Badge should be visible from the previous test restoring it
    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(true);

    // Right-click a page element to get the page-level context menu
    await page.click('[data-vibeflow-id="main-nav"]', { button: "right" });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!host?.shadowRoot?.querySelector(".vibeflow-context-menu");
    }, { timeout: 2000 });

    const hasHideBtn = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const menu = host?.shadowRoot?.querySelector(".vibeflow-context-menu");
      return Array.from(menu?.querySelectorAll("button") ?? [])
        .some((b) => b.textContent?.includes("Hide Vibeflow"));
    });
    expect(hasHideBtn).toBe(true);

    // Close menu without hiding
    await page.keyboard.press("Escape");
    await page.click("body");
  });

  it("right-clicking page element shows Disable Vibeflow option", async () => {
    // Right-click a page element to get the page-level context menu
    await page.click('[data-vibeflow-id="main-nav"]', { button: "right" });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!host?.shadowRoot?.querySelector(".vibeflow-context-menu");
    }, { timeout: 2000 });

    const hasDisableBtn = await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const menu = host?.shadowRoot?.querySelector(".vibeflow-context-menu");
      return Array.from(menu?.querySelectorAll("button") ?? [])
        .some((b) => b.textContent?.includes("Disable Vibeflow"));
    });
    expect(hasDisableBtn).toBe(true);

    // Close menu without disabling
    await page.keyboard.press("Escape");
    await page.click("body");
  });

  it("clicking Disable Vibeflow removes the overlay entirely", async () => {
    expect(await shadowExists(page, ".vibeflow-corner-trigger")).toBe(true);

    // Right-click a page element and click "Disable Vibeflow"
    await page.click('[data-vibeflow-id="main-nav"]', { button: "right" });

    await page.waitForFunction(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      return !!host?.shadowRoot?.querySelector(".vibeflow-context-menu");
    }, { timeout: 2000 });

    await page.evaluate(() => {
      const host = document.querySelector("#vibeflow-studio-root") as HTMLElement;
      const menu = host?.shadowRoot?.querySelector(".vibeflow-context-menu");
      const btn = Array.from(menu?.querySelectorAll("button") ?? [])
        .find((b) => b.textContent?.includes("Disable Vibeflow")) as HTMLElement | undefined;
      btn?.click();
    });

    // The host element should be removed from the DOM
    await page.waitForFunction(() => {
      return !document.getElementById("vibeflow-studio-root");
    }, { timeout: 2000 });

    expect(await page.evaluate(() => !document.getElementById("vibeflow-studio-root"))).toBe(true);

    // Right-clicking after disable should NOT show a vibeflow context menu
    await page.click('[data-vibeflow-id="main-nav"]', { button: "right" });
    await page.waitForTimeout(500);
    const hasContextMenu = await page.evaluate(() => {
      const host = document.getElementById("vibeflow-studio-root") as HTMLElement | null;
      return !!host?.shadowRoot?.querySelector(".vibeflow-context-menu");
    });
    expect(hasContextMenu).toBe(false);
  });

  // ── Directory serve: index page ───────────────────────────────────────────
  it("directory index page is served when a directory is given", async () => {
    const res = await fetch(BASE);
    expect(res.ok).toBe(true);
  });
});
