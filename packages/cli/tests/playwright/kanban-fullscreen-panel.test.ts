/**
 * Fullscreen detail panel (cba0ade6) — seeded `panelFullscreen: true` opens
 * every task in a viewport-wide overlay; the header toggle restores the exact
 * saved `panelWidth`; the flag persists across reloads; X/Escape still close.
 *
 * Non-vacuity: with the `#detail-panel-container.fullscreen` CSS rule
 * commented out, the "computed width ≈ viewport width" assertion fails — the
 * spec measures the rule, not just the class.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

// Scratch board only — never the owner's port 3700.
const PORT = 45231;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/tasks`;

const PANEL_WIDTH = 500;

const STALE_DIST_MSG =
  "dist/client/kanban-browser.js is older than the newest kanban source " +
  "file. The Playwright suite would test a stale bundle. Run " +
  "`pnpm --filter @vibeflow-tools/cli run build` first.";

/** Newest mtime (ms) across non-test *.ts/*.tsx/*.css under a tree. */
function newestSourceMtime(root: string): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
      } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  walk(root);
  return newest;
}

describe("fullscreen detail panel (cba0ade6)", () => {
  let browser: Browser;
  let tempDir: string;
  let instance: ServeInstance;
  let taskId: string;

  async function createTask(body: Record<string, unknown>): Promise<string> {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selector: "#fullscreen-panel", ...body }),
    });
    const j = (await r.json()) as { task?: { id: string } };
    if (!j.task) throw new Error(`create failed: ${JSON.stringify(j)}`);
    return j.task.id;
  }

  function seedSettings(settings: Record<string, unknown>): void {
    mkdirSync(join(tempDir, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(tempDir, ".vibeflow", "settings.json"),
      JSON.stringify(settings, null, 2),
    );
  }

  async function openBoard(): Promise<Page> {
    const page = await browser.newPage();
    await page.goto(`${BASE}/kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#kanban-board", { timeout: 15000 });
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-task-id="${id}"]`),
      taskId,
      { timeout: 15000 },
    );
    await page.waitForTimeout(400);
    return page;
  }

  async function openPanel(page: Page): Promise<void> {
    await page.locator(`[data-task-id="${taskId}"]`).first().click();
    await page.waitForSelector("#detail-panel", { timeout: 10000 });
    await page.waitForTimeout(400);
  }

  /** Container class + rendered width + toggle affordance state. */
  async function probeContainer(page: Page): Promise<{
    fullscreen: boolean;
    width: number;
    viewport: number;
    pressed: string | null;
    title: string | null;
  }> {
    return page.evaluate(() => {
      const el = document.getElementById("detail-panel-container");
      if (!el) throw new Error("no detail-panel-container");
      const toggle = document.getElementById("dp-fullscreen-toggle");
      return {
        fullscreen: el.classList.contains("fullscreen"),
        width: el.getBoundingClientRect().width,
        viewport: window.innerWidth,
        pressed: toggle?.getAttribute("aria-pressed") ?? null,
        title: toggle?.getAttribute("title") ?? null,
      };
    });
  }

  beforeAll(async () => {
    const distMtime = statSync("dist/client/kanban-browser.js").mtimeMs;
    const srcNewest = Math.max(
      newestSourceMtime(join("src", "client", "kanban")),
      newestSourceMtime(join("..", "ui", "src", "kanban")),
    );
    expect(distMtime, STALE_DIST_MSG).toBeGreaterThanOrEqual(srcNewest);
    tempDir = mkdtempSync(join(tmpdir(), "fullscreen-panel-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    taskId = await createTask({ title: "FULLSCREEN PANEL CARD", status: "todo" });
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await instance?.close?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("seeded flag fullscreen-opens, toggle restores exact width, reload persists, X/Escape close", async () => {
    seedSettings({
      viewMode: "board",
      panelWidth: PANEL_WIDTH,
      panelFullscreen: true,
    });
    const page = await openBoard();
    try {
      await openPanel(page);

      // 1. Seeded flag → fullscreen overlay, viewport-wide (proves the CSS rule).
      let probe = await probeContainer(page);
      expect(probe.fullscreen).toBe(true);
      expect(probe.pressed).toBe("true");
      expect(probe.title).toBe("Restore panel");
      expect(Math.abs(probe.width - probe.viewport)).toBeLessThan(2);

      // 2. SERVER FILTER: the flag round-trips through POST /api/settings
      // while unknown keys are dropped (SETTABLE_KEYS guard).
      const csrf = await page.evaluate(() =>
        document.querySelector('meta[name="csrf-token"]')?.getAttribute("content"),
      );
      const post = await page.evaluate(async (token) => {
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "x-csrf-token": token } : {}),
          },
          body: JSON.stringify({ panelFullscreen: false, bogusKey: 1 }),
        });
        return { status: r.status, body: await r.json() };
      }, csrf);
      expect(post.status).toBe(200);
      expect(post.body.settings.panelFullscreen).toBe(false);
      expect(post.body.settings).not.toHaveProperty("bogusKey");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#kanban-board", { timeout: 15000 });
      await page.waitForTimeout(400);

      // 3. Server round-trip flipped the flag → reopen is windowed at the
      // exact seeded width (restore exactness, panelWidth never clobbered).
      await openPanel(page);
      probe = await probeContainer(page);
      expect(probe.fullscreen).toBe(false);
      expect(probe.pressed).toBe("false");
      expect(Math.abs(probe.width - PANEL_WIDTH)).toBeLessThan(2);

      // 4. Toggle on → fullscreen again; reload persists (global preference).
      await page.locator("#dp-fullscreen-toggle").click();
      await page.waitForTimeout(300);
      probe = await probeContainer(page);
      expect(probe.fullscreen).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#kanban-board", { timeout: 15000 });
      await page.waitForTimeout(400);
      await openPanel(page);
      probe = await probeContainer(page);
      expect(probe.fullscreen).toBe(true);
      expect(Math.abs(probe.width - probe.viewport)).toBeLessThan(2);

      // 5. X still closes; reopen honors the flag (global scope proof).
      await page.locator("#dp-close").click();
      await page.waitForSelector("#detail-panel", { state: "detached", timeout: 10000 });
      await openPanel(page);
      expect((await probeContainer(page)).fullscreen).toBe(true);

      // 6. Escape still closes.
      await page.keyboard.press("Escape");
      await page.waitForSelector("#detail-panel", { state: "detached", timeout: 10000 });
    } finally {
      await page.close();
    }
  });
});
