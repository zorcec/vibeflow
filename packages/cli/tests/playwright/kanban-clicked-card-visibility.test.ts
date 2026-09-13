/**
 * Real-pointer regression test for task aa9cf784 — "clicking a task card makes
 * it disappear".
 *
 * The card is never removed from the board: `openedBy` (the per-user read
 * state) is only ever read to draw the unread dot, and the full per-column DOM
 * id list is byte-identical before and after a click. What the owner saw is
 * geometry: the detail panel is an absolutely positioned OVERLAY
 * (`#detail-panel-container` is `position:absolute; right:0`), so on a viewport
 * narrower than board + panel it covers the card that was just clicked. With
 * the persisted `panelWidth: 860` at 1440x900 the panel's left edge lands at
 * x=580 and the in-progress (612) / review (908) / done (1204) lanes sit under
 * it. The board could not be scrolled to the card either — its scroll range at
 * that size was 64px — so closing the panel was the only way back, which is
 * what made the card read as "gone".
 *
 * The fix insets the board by the panel's LIVE width while the panel is open
 * (so the board's box is exactly the visible band) and scrolls the clicked card
 * into that band, restoring the previous scroll when the panel closes.
 *
 * Real pointer input only: `page.mouse` press/release, and the verdict is
 * `document.elementFromPoint` at the card's own centre — "visible" means the
 * user can see the card and click it, not merely that it exists in the DOM.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3973;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/tasks`;

/** The owner's persisted panel width (`.vibeflow/settings.json`). */
const WIDE_PANEL = 860;
/** A second, non-default width — proves the inset tracks the live value. */
const NARROW_PANEL = 600;

interface CardProbe {
  inDom: boolean;
  rect?: { left: number; right: number; top: number; bottom: number };
  /** The card is the top-most element at its own centre — visible AND clickable. */
  topIsSelf?: boolean;
  /** The card sits entirely left of the panel. */
  clearOfPanel?: boolean;
  /** The card sits inside the board's own box. */
  insideBoard?: boolean;
  boardScrollLeft?: number;
}

describe("clicked card stays visible (aa9cf784)", () => {
  let browser: Browser;
  let tempDir: string;
  let instance: ServeInstance;
  let reviewTaskId: string;

  async function createTask(body: Record<string, unknown>): Promise<string> {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selector: "#clicked-card", ...body }),
    });
    const j = (await r.json()) as { task?: { id: string } };
    if (!j.task) throw new Error(`create failed: ${JSON.stringify(j)}`);
    return j.task.id;
  }

  /** The board's own box and scroll state, plus a probe of one card. */
  async function probeCard(page: Page, taskId: string): Promise<CardProbe> {
    return page.evaluate((id) => {
      const board = document.getElementById("kanban-board");
      const panel = document.getElementById("detail-panel-container");
      const el = document.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
      const boardScrollLeft = board?.scrollLeft ?? -1;
      if (!el) return { inDom: false, boardScrollLeft };
      const r = el.getBoundingClientRect();
      const centre = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      const boardRect = board?.getBoundingClientRect();
      const panelRect = panel?.getBoundingClientRect();
      return {
        inDom: true,
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        topIsSelf: !!centre?.closest(`[data-task-id="${id}"]`),
        clearOfPanel: panelRect ? r.right <= panelRect.left : true,
        insideBoard: boardRect
          ? r.left >= boardRect.left - 1 && r.right <= boardRect.right + 1
          : false,
        boardScrollLeft,
      };
    }, taskId);
  }

  /** Real pointer press + release on the card's centre. */
  async function clickCard(page: Page, taskId: string): Promise<void> {
    const centre = await page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
      if (!el) throw new Error(`card ${id} not found`);
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, taskId);
    await page.mouse.move(centre.x, centre.y);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(600);
  }

  async function openBoard(
    viewport: { width: number; height: number },
    panelWidth: number,
  ): Promise<{ context: BrowserContext; page: Page }> {
    writeFileSync(
      join(tempDir, ".vibeflow", "settings.json"),
      JSON.stringify({ viewMode: "board", panelWidth }, null, 2),
    );
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(`${BASE}/kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#kanban-board", { timeout: 15000 });
    await page.waitForFunction(
      (id) => !!document.querySelector(`[data-task-id="${id}"]`),
      reviewTaskId,
      { timeout: 15000 },
    );
    await page.waitForTimeout(400);
    return { context, page };
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "clicked-card-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    // Backlog tasks give the review column a column-3 position (x=888 at
    // 1440x900), which is what the panel covers.
    for (let i = 0; i < 3; i++) {
      await createTask({
        title: `BACKLOG CARD ${i}`,
        status: "backlog",
        sortKey: String(i + 1).padStart(16, "0"),
      });
    }
    reviewTaskId = await createTask({
      title: "REVIEW CARD UNDER THE PANEL",
      status: "review",
      sortKey: "0000000000000040",
    });
    browser = await chromium.launch({ headless: true });
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await instance?.close?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the clicked card visible next to the owner's 860px panel", async () => {
    const { context, page } = await openBoard(
      { width: 1440, height: 900 },
      WIDE_PANEL,
    );
    const before = await probeCard(page, reviewTaskId);
    expect(before.inDom).toBe(true);
    const boardScrollBefore = before.boardScrollLeft ?? 0;

    await clickCard(page, reviewTaskId);

    // The panel really is the overlay the owner has persisted.
    const panelWidth = await page.evaluate(
      () =>
        document.getElementById("detail-panel-container")?.getBoundingClientRect()
          .width ?? 0,
    );
    expect(panelWidth).toBeGreaterThanOrEqual(WIDE_PANEL - 1);
    expect(await page.locator("#detail-panel-container").count()).toBe(1);

    const after = await probeCard(page, reviewTaskId);
    expect(after.inDom, "clicking must not remove the card").toBe(true);
    expect(
      after.topIsSelf,
      `the card must still be the top-most element at its centre: ${JSON.stringify(after)}`,
    ).toBe(true);
    expect(
      after.clearOfPanel,
      `the card must not sit under the panel: ${JSON.stringify(after)}`,
    ).toBe(true);
    expect(
      after.insideBoard,
      `the card must be inside the board's visible box: ${JSON.stringify(after)}`,
    ).toBe(true);
    // The board moved, once, to bring the card into the visible band.
    expect(after.boardScrollLeft ?? 0).toBeGreaterThan(boardScrollBefore);

    // Closing the panel returns the board to where the user left it.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const closed = await probeCard(page, reviewTaskId);
    expect(closed.boardScrollLeft ?? 0).toBe(boardScrollBefore);

    await context.close();
  }, 60000);

  it("moves nothing when the panel does not cover the card (2560x1400)", async () => {
    const { context, page } = await openBoard(
      { width: 2560, height: 1400 },
      WIDE_PANEL,
    );
    const before = await probeCard(page, reviewTaskId);
    const boardScrollBefore = before.boardScrollLeft ?? 0;
    expect(before.topIsSelf).toBe(true);

    await clickCard(page, reviewTaskId);

    const after = await probeCard(page, reviewTaskId);
    expect(after.topIsSelf).toBe(true);
    expect(after.clearOfPanel).toBe(true);
    // The wide case is a no-op by construction, not by luck.
    expect(after.boardScrollLeft ?? -1).toBe(boardScrollBefore);

    await context.close();
  }, 60000);

  it("tracks the panel width the user actually resized to (600px)", async () => {
    const { context, page } = await openBoard(
      { width: 1440, height: 900 },
      NARROW_PANEL,
    );
    await clickCard(page, reviewTaskId);

    const panelWidth = await page.evaluate(
      () =>
        document.getElementById("detail-panel-container")?.getBoundingClientRect()
          .width ?? 0,
    );
    // Reads the live value — a hardcoded 860 would leave this at 860.
    expect(panelWidth).toBeGreaterThanOrEqual(NARROW_PANEL - 1);
    expect(panelWidth).toBeLessThan(WIDE_PANEL - 40);

    const after = await probeCard(page, reviewTaskId);
    expect(after.topIsSelf).toBe(true);
    expect(after.clearOfPanel).toBe(true);
    expect(after.insideBoard).toBe(true);

    await context.close();
  }, 60000);
});
