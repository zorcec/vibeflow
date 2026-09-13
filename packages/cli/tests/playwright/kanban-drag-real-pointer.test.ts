/**
 * Real-pointer regression test for the kanban drag-abort bug (task 47dc2d92).
 *
 * Symptom: dragging cards did nothing — the drag event log showed
 * `dragstart → dragend` a few pixels later with ZERO dragenter/dragover/drop,
 * so no reorder PATCH was ever written.
 *
 * Why this test looks like this: synthetic `new DragEvent(...)` dispatch CANNOT
 * reproduce the bug. Synthetic events bypass the browser's native drag
 * initiation — the window in which a synchronous React state flush inside
 * `handleDragStart` races the drag-image capture and aborts the session. Ten
 * earlier attempts "passed" against synthetic dispatch while the real drag
 * still died.
 *
 * So the drag here is driven by a REAL pointer press + pointer moves through
 * Chromium's own drag controller. Playwright hands a live drag session to the
 * client only once the browser accepts it (CDP `Input.dragIntercepted`); an
 * aborted drag never produces that handover and the next mouse move hangs.
 * That hang IS the bug, so every move is capped — a cap hit is turned into an
 * ordinary assertion failure instead of a test timeout.
 *
 * The board is built to the geometry from the report: 1310x720 viewport, 15
 * review cards (the review column scrolls), board wider than the viewport.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3971;
const BASE = `http://localhost:${PORT}`;
const API = `http://localhost:${PORT}/api/tasks`;

/** Enough review cards to overflow the column at the reported 720px height. */
const REVIEW_CARD_COUNT = 15;

/** Playwright mouse events are dispatched one at a time; 12 steps gives the
 *  browser several chances to track the drag across the target card. */
const DRAG_STEPS = 12;

/** Cap for a mouse move that the browser may hold while it claims the drag. */
const DRAG_HANDOVER_MS = 4000;

interface DragRecord {
  type: string;
  tag: string;
  taskId: string | null;
}

interface CardRect {
  id: string;
  /** Viewport coordinates of the card's top edge (the reorder drop band). */
  x: number;
  top: number;
  height: number;
}

async function createTask(body: Record<string, unknown>): Promise<string> {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selector: "#dnd-real-pointer", ...body }),
  });
  const j = (await r.json()) as { task?: { id: string } };
  if (!j.task) throw new Error(`create failed: ${JSON.stringify(j)}`);
  return j.task.id;
}

async function getTask(id: string): Promise<{ sortKey?: string }> {
  const r = await fetch(`${API}/${id}`);
  return (await r.json()) as { sortKey?: string };
}

/** Capture every drag event that reaches the document, with its target. */
async function installDragLogger(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __dragLog: DragRecord[] };
    w.__dragLog = [];
    for (const type of [
      "dragstart",
      "dragenter",
      "dragover",
      "drop",
      "dragend",
    ]) {
      document.addEventListener(
        type,
        (e) => {
          const el = e.target as HTMLElement;
          w.__dragLog.push({
            type,
            tag: el.tagName,
            taskId: el.getAttribute?.("data-task-id") ?? null,
          });
        },
        true,
      );
    }
  });
}

async function readDragLog(page: Page): Promise<DragRecord[]> {
  return page.evaluate(
    () => (window as unknown as { __dragLog: DragRecord[] }).__dragLog,
  );
}

/** Visible review cards in board order, with viewport coordinates. */
async function reviewCardRects(page: Page): Promise<CardRect[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '#kanban-board [data-column-id="review"] article.task-card',
      ),
    ]
      .map((card) => {
        const r = card.getBoundingClientRect();
        return {
          id: card.dataset.taskId ?? "",
          x: r.x + r.width / 2,
          top: r.y,
          height: r.height,
          visible:
            r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
        };
      })
      .filter((c) => c.visible)
      .map(({ id, x, top, height }) => ({ id, x, top, height })),
  );
}

/** Move the pointer, capped: a `false` result means the browser never handed
 *  the drag session over, i.e. the page aborted it. */
async function moveWithDragHandover(
  page: Page,
  x: number,
  y: number,
): Promise<boolean> {
  return Promise.race([
    page.mouse.move(x, y).then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), DRAG_HANDOVER_MS),
    ),
  ]);
}

/** Release the pointer, capped as well (an aborted drag can leave the release
 *  waiting on the browser too). */
async function releaseWithTimeout(page: Page): Promise<void> {
  await Promise.race([
    page.mouse.up(),
    new Promise<void>((resolve) => setTimeout(resolve, DRAG_HANDOVER_MS)),
  ]);
}

describe("kanban DnD with a real pointer (drag-abort regression)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "dnd-real-pointer-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    for (let i = 0; i < REVIEW_CARD_COUNT; i++) {
      await createTask({
        title: `REVIEW CARD ${String(i).padStart(2, "0")}`,
        status: "review",
        sortKey: String(i + 1).padStart(16, "0"),
      });
    }
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1310, height: 720 },
    });
    page = await context.newPage();
  }, 60000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reorders a real drag instead of aborting it at dragstart", async () => {
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patches.push(req.url());
    });

    await page.goto(`${BASE}/kanban`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await page.waitForSelector("#kanban-board", { timeout: 10000 });
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(
          '#kanban-board [data-column-id="review"] article.task-card',
        ).length === count,
      REVIEW_CARD_COUNT,
      { timeout: 10000 },
    );

    await installDragLogger(page);

    const cards = await reviewCardRects(page);
    expect(cards.length).toBeGreaterThanOrEqual(3);
    // Drag the third visible card up onto the first one's reorder band. Same
    // column, both cards visible, so the pointer never has to leave the
    // viewport (two-axis scroll reachability is a separate, still-open issue).
    const source = cards[2];
    const target = cards[0];
    const targetBandY = target.top + 4;
    const before = await getTask(source.id);

    await page.mouse.move(source.x, source.top + source.height / 2);
    await page.mouse.down();

    let dragHandover = true;
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const t = i / DRAG_STEPS;
      const moved = await moveWithDragHandover(
        page,
        source.x + (target.x - source.x) * t,
        source.top + source.height / 2 + (targetBandY - (source.top + source.height / 2)) * t,
      );
      if (!moved) {
        dragHandover = false;
        break;
      }
      await page.waitForTimeout(20);
    }
    await releaseWithTimeout(page);
    await page.waitForTimeout(800);

    const log = await readDragLog(page);
    const diagnostics = `dragLog=${JSON.stringify(log)} patches=${JSON.stringify(patches)}`;
    const dragoverOnCard = log.filter(
      (e) => e.type === "dragover" && e.tag === "ARTICLE",
    ).length;
    const drops = log.filter((e) => e.type === "drop").length;
    const after = await getTask(source.id);

    // The browser handed the drag session to the client — it did not die
    // inside the dragstart dispatch.
    expect(dragHandover, `the browser never claimed the drag. ${diagnostics}`).toBe(
      true,
    );
    expect(
      dragoverOnCard,
      `expected >=1 dragover on a task card. ${diagnostics}`,
    ).toBeGreaterThanOrEqual(1);
    expect(drops, `expected a drop event. ${diagnostics}`).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      patches.some((url) => url.includes(`/api/tasks/${source.id}`)),
      `expected a PATCH for the dragged card. ${diagnostics}`,
    ).toBe(true);
    expect(
      after.sortKey,
      `the drop must have persisted a reorder. ${diagnostics}`,
    ).not.toBe(before.sortKey);
  }, 60000);
});
