/**
 * Playwright e2e — the Unlink affordance must not take space at rest
 * (ticket cfqggn1w: "Unlink is visible on hover only, but takes space
 * all the time — it should only take space if it is visible").
 *
 * Surface: the detail panel's CHILDREN tree — the wired Unlink host on
 * this board (shared DetailPanel → RelationsSection → RecursiveChildrenTree
 * → ChildRow; the CLI board's inline tree receives no onDetach at all,
 * so it renders no button). The same shared ChildRow serves the web
 * board's inline rows.
 *
 * The child-row action strip renders CopyId + Unlink as sibling tabs.
 * CopyId already contracts to 0 width when not revealed (its `revealed`
 * contract), but Unlink only faded with `opacity: 0` — the padding and
 * label stayed laid out on every render and permanently stole ~60px
 * from the row.
 *
 * Asserts the owner's rule directly:
 *  - at rest the button occupies ZERO width (no space taken),
 *  - hovering the row reveals it (width > 0),
 *  - keyboard focus reveals it too — a zero-width collapse must stay
 *    focusable so the reveal is not mouse-only.
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

const PORT = 3984;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/tasks`;

describe("child-row Unlink only takes space while visible", () => {
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
      body: JSON.stringify({ selector: "#unlink-space", ...body }),
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
    tempDir = mkdtempSync(join(tmpdir(), "unlink-space-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    parentId = await createTask({
      title: "PARENT WITH UNLINK",
      status: "todo",
      sortKey: "0000000000000001",
    });
    childId = await createTask({
      title: "CHILD TO UNLINK",
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
    // The Unlink host on this board is the detail panel's children tree:
    // open the parent's panel by clicking its card.
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

  it("takes no space at rest — the hidden Unlink button collapses to zero width", async () => {
    // Guard against a missing button reading as "0 width": the panel row
    // must actually render the affordance (onDetach is wired here).
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
    // And it collapses again when the pointer leaves the row.
    await page.locator("#kanban-board").hover({ position: { x: 5, y: 5 } });
    await expect
      .poll(async () => await unlinkWidth(), { timeout: 3000 })
      .toBe(0);
  });

  it("stays keyboard-revealable — focusing the zero-width button expands it", async () => {
    // Zero width must not mean display:none: keyboard users reach the
    // control by tabbing/focusing, which sets unlinkFocus -> revealed.
    // The state update is async — give React one tick before measuring.
    const revealed = await page.evaluate(async (sel) => {
      const btn = document.querySelector<HTMLElement>(sel);
      if (!btn) return false;
      btn.focus();
      await new Promise((r) => setTimeout(r, 50));
      return document.activeElement === btn && btn.getBoundingClientRect().width > 0;
    }, `${wrapSelector()} .relation-remove`);
    expect(revealed).toBe(true);
    // Blur collapses it back.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect
      .poll(async () => await unlinkWidth(), { timeout: 3000 })
      .toBe(0);
  });
});
