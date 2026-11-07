/**
 * Playwright e2e — local served kanban child detach (ticket 9c4872a0):
 * hover reveals Unlink on a child, it takes no space at rest, keyboard
 * focus reveals it too, and clicking through the confirm unlinks the
 * child. Plus the status-dot parity assertion matching online: the board
 * hides the redundant tile mark (online globals.css rule
 * `#kanban-board .task-card > div:first-child > [data-role="status-dot"]`;
 * local mirror lives in the CLI kanban stylesheet only — the shared
 * StatusDot component in packages/ui is untouched, ticket kwaz437j).
 *
 * Mirrors kanban-child-unlink-space.test.ts (same served-kanban surface:
 * the detail panel's CHILDREN tree, the wired Unlink host on this board)
 * and extends it with the click-unlinks proof plus the dot assertion that
 * prior commit 05d61f1 left out.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium } from "playwright";
import { guardContext, type ErrorGuard } from "./error-guard";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3985;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/tasks`;

describe("local kanban child detach + status-dot parity", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let guard: ErrorGuard;
  let tempDir: string;
  let instance: ServeInstance;
  let parentId: string;
  let childId: string;

  async function createTask(body: Record<string, unknown>): Promise<string> {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selector: "#detach-proof", ...body }),
    });
    const j = (await r.json()) as { task?: { id: string } };
    if (!j.task) throw new Error(`create failed: ${JSON.stringify(j)}`);
    return j.task.id;
  }

  const wrapSelector = () =>
    `#detail-panel [data-role="child-row-wrap"][data-task-id="${childId}"]`;

  async function unlinkWidth(): Promise<number> {
    return page.evaluate((sel) => {
      const btn = document.querySelector<HTMLElement>(sel);
      return btn ? btn.getBoundingClientRect().width : -1;
    }, `${wrapSelector()} .relation-remove`);
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "detach-proof-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    parentId = await createTask({
      title: "DETACH PARENT",
      status: "todo",
      sortKey: "0000000000000001",
    });
    childId = await createTask({
      title: "DETACH CHILD",
      status: "todo",
      sortKey: "0000000000000002",
      links: [{ taskId: parentId, type: "parent" }],
    });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();
    guard = guardContext(context);
    await page.goto(`${BASE}/kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#kanban-board", { timeout: 15000 });
    await page.waitForFunction(
      () => document.querySelectorAll("article.task-card").length > 0,
      { timeout: 15000 },
    );
    await page.locator(`article.task-card[data-task-id="${parentId}"]`).click();
    await page.waitForSelector(wrapSelector(), { timeout: 15000 });
  }, 60000);

  afterEach(() => guard.assertNoErrors());

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("no visible status dot on board tiles — matches online (dot hidden, not deleted)", async () => {
    // Guard against a vacuous pass: tiles must actually render the dot in
    // the DOM (shared StatusDot kept) while the local stylesheet hides it.
    const dots = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '#kanban-board .task-card > div:first-child > [data-role="status-dot"]',
        ),
      ] as HTMLElement[];
      return {
        total: nodes.length,
        visible: nodes.filter((n) => {
          const rect = n.getBoundingClientRect();
          const style = window.getComputedStyle(n);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        }).length,
      };
    });
    expect(dots.total).toBeGreaterThan(0);
    expect(dots.visible).toBe(0);
  });

  it("takes no space at rest — the hidden Unlink button collapses to zero width", async () => {
    await expect
      .poll(() => page.locator(`${wrapSelector()} .relation-remove`).count())
      .toBe(1);
    expect(await unlinkWidth()).toBe(0);
  });

  it("reveals on row hover — width becomes positive while visible", async () => {
    await page.locator(wrapSelector()).hover();
    await expect
      .poll(async () => await unlinkWidth(), { timeout: 3000 })
      .toBeGreaterThan(0);
    await page.locator("#kanban-board").hover({ position: { x: 5, y: 5 } });
    await expect
      .poll(async () => await unlinkWidth(), { timeout: 3000 })
      .toBe(0);
  });

  it("stays keyboard-revealable — focusing the zero-width button expands it", async () => {
    const revealed = await page.evaluate(async (sel) => {
      const btn = document.querySelector<HTMLElement>(sel);
      if (!btn) return false;
      btn.focus();
      await new Promise((r) => setTimeout(r, 50));
      return document.activeElement === btn && btn.getBoundingClientRect().width > 0;
    }, `${wrapSelector()} .relation-remove`);
    expect(revealed).toBe(true);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect
      .poll(async () => await unlinkWidth(), { timeout: 3000 })
      .toBe(0);
  });

  it("click unlinks — confirming removes the child row and frees the child", async () => {
    await page.locator(wrapSelector()).hover();
    await page.locator(`${wrapSelector()} .relation-remove`).click();
    // The shared RelationsSection gates removal behind a confirm modal.
    await page.waitForSelector("#confirm-modal-confirm", { timeout: 5000 });
    await page.locator("#confirm-modal-confirm").click();
    // The child row leaves the parent's CHILDREN tree…
    await expect
      .poll(() => page.locator(wrapSelector()).count(), { timeout: 10000 })
      .toBe(0);
    // …and the child survives as a root card on the board (detach, not delete).
    await expect
      .poll(
        () =>
          page.locator(`article.task-card[data-task-id="${childId}"]`).count(),
        { timeout: 10000 },
      )
      .toBe(1);
  });
});
