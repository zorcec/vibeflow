/**
 * PHASE-1 reproduction probe for task 1ec7068e.
 *
 * Question: does `KanbanListView` repeat the drag-abort bug fixed for the board
 * in 87748ad (`dragstart -> dragend` a few pixels later, ZERO
 * dragenter/dragover/drop, no reorder PATCH)?
 *
 * The list view's `ListRow.onDragStart` publishes React state SYNCHRONOUSLY
 * inside the dragstart dispatch (`onDragStart(task.id)` -> `setDragTaskId`),
 * which is the same shape as the board bug. This test drives a REAL pointer
 * drag (Playwright mouse press + moves) against the list view, both at the top
 * of the list and while the list is scrolled, and records the full drag event
 * sequence. Synthetic `new DragEvent(...)` dispatch is deliberately NOT used —
 * it bypasses native drag initiation, which is where this bug class lives.
 *
 * Scratch port 3757 (3710+; never 3700).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3757;
const BASE = `http://localhost:${PORT}`;
const API = `http://localhost:${PORT}/api/tasks`;

/** Plenty of review rows so the list overflows the 720px viewport. */
const REVIEW_CARD_COUNT = 40;

/** Capped handover window: an aborted drag hangs the next mouse move. */
const DRAG_HANDOVER_MS = 4000;

const DRAG_STEPS = 14;

interface DragRecord {
  type: string;
  tag: string;
  taskId: string | null;
  protoId: string | null;
}

interface RowRect {
  id: string;
  status: string;
  x: number;
  top: number;
  height: number;
}

async function createTask(body: Record<string, unknown>): Promise<string> {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selector: "#list-dnd-repro", ...body }),
  });
  const j = (await r.json()) as { task?: { id: string } };
  if (!j.task) throw new Error(`create failed: ${JSON.stringify(j)}`);
  return j.task.id;
}

async function getTask(id: string): Promise<{ status?: string }> {
  const r = await fetch(`${API}/${id}`);
  return (await r.json()) as { status?: string };
}

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
            taskId: el.dataset?.taskId ?? null,
            protoId: el.dataset?.protoId ?? null,
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

/** Visible list rows (in DOM order) with viewport coordinates. A row counts as
 *  visible only when it sits fully inside BOTH the scroll container's clip box
 *  and the viewport — `getBoundingClientRect` reports scrolled-out rows too. */
async function listRowRects(page: Page): Promise<RowRect[]> {
  return page.evaluate(() => {
    const container = document.getElementById("kanban-list-view");
    if (!container) return [];
    const c = container.getBoundingClientRect();
    const top = Math.max(0, c.top);
    const bottom = Math.min(window.innerHeight, c.bottom);
    return [
      ...document.querySelectorAll<HTMLElement>(
        '#kanban-list-view [data-proto-id="list-row"]',
      ),
    ]
      .map((row) => {
        const r = row.getBoundingClientRect();
        return {
          id: row.dataset.taskId ?? "",
          status: row.dataset.groupStatus ?? "",
          x: r.x + r.width / 2,
          top: r.y,
          height: r.height,
          visible: r.height > 0 && r.top >= top && r.bottom <= bottom,
        };
      })
      .filter((r) => r.visible)
      .map(({ id, status, x, top: rtop, height }) => ({
        id,
        status,
        x,
        top: rtop,
        height,
      }));
  });
}

/** Tag each row with the status of its enclosing group so we can pick a
 *  cross-status target without relying on header hit-testing. */
async function tagRowsWithGroupStatus(page: Page) {
  await page.evaluate(() => {
    const groups = [
      ...document.querySelectorAll<HTMLElement>("#kanban-list-view > div"),
    ];
    for (const group of groups) {
      const span = group.querySelector(":scope > div span");
      const status = span?.textContent?.trim() ?? "";
      group
        .querySelectorAll<HTMLElement>('[data-proto-id="list-row"]')
        .forEach((row) => {
          row.dataset.groupStatus = status;
        });
    }
  });
}

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

async function releaseWithTimeout(page: Page): Promise<void> {
  await Promise.race([
    page.mouse.up(),
    new Promise<void>((resolve) => setTimeout(resolve, DRAG_HANDOVER_MS)),
  ]);
}

interface DragOutcome {
  log: DragRecord[];
  patches: string[];
  handover: boolean;
}

/** Drive a real pointer drag from one row to a target point. */
async function realDrag(
  page: Page,
  source: RowRect,
  targetPoint: { x: number; y: number },
  patches: string[],
): Promise<DragOutcome> {
  await page.mouse.move(source.x, source.top + source.height / 2);
  await page.mouse.down();

  let handover = true;
  const startY = source.top + source.height / 2;
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const t = i / DRAG_STEPS;
    const moved = await moveWithDragHandover(
      page,
      source.x + (targetPoint.x - source.x) * t,
      startY + (targetPoint.y - startY) * t,
    );
    if (!moved) {
      handover = false;
      break;
    }
    await page.waitForTimeout(20);
  }
  await releaseWithTimeout(page);
  await page.waitForTimeout(800);

  return { log: await readDragLog(page), patches, handover };
}

describe("KanbanListView real-pointer drag (1ec7068e probe)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;
  let targetId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "listview-dnd-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    // One in-progress row near the top to serve as a cross-status drop target.
    targetId = await createTask({
      title: "IN-PROGRESS TARGET",
      status: "in-progress",
      sortKey: "0000000000000001",
    });
    for (let i = 0; i < REVIEW_CARD_COUNT; i++) {
      await createTask({
        title: `REVIEW ROW ${String(i).padStart(2, "0")}`,
        status: "review",
        sortKey: String(i + 2).padStart(16, "0"),
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

  async function openListView(): Promise<void> {
    await page.goto(`${BASE}/kanban`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    // The view mode is persisted in settings, so a reload can already land in
    // list mode — only click the toggle when the board happens to be showing.
    await page.waitForSelector("#kanban-board, #kanban-list-view", {
      timeout: 10000,
    });
    if ((await page.locator("#kanban-list-view").count()) === 0) {
      await page.click('[title="List view"]');
    }
    await page.waitForSelector("#kanban-list-view", { timeout: 10000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          '#kanban-list-view [data-proto-id="list-row"]',
        ).length >= 2,
      undefined,
      { timeout: 10000 },
    );
    await tagRowsWithGroupStatus(page);
    await installDragLogger(page);
  }

  it("survives a real drag from a review row onto the in-progress row (top of list)", async () => {
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patches.push(req.url());
    });

    await openListView();

    const overflow = await page.evaluate(() => {
      const el = document.getElementById("kanban-list-view")!;
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollable: el.scrollHeight > el.clientHeight,
      };
    });
    console.log("[probe] list overflow:", JSON.stringify(overflow));

    const rows = await listRowRects(page);
    console.log(
      "[probe] top-of-list visible rows:",
      JSON.stringify(rows.map((r) => ({ id: r.id, status: r.status }))),
    );

    const target = rows.find((r) => r.id === targetId);
    expect(target, "in-progress target row must be visible").toBeTruthy();
    const source = rows.find((r) => r.status === "review" && r.id !== targetId);
    expect(source, "a visible review source row is required").toBeTruthy();

    const before = await getTask(source!.id);
    const outcome = await realDrag(
      page,
      source!,
      { x: target!.x, y: target!.top + target!.height / 2 },
      patches,
    );
    const after = await getTask(source!.id);

    const raw = JSON.stringify(outcome.log);
    console.log("[probe] TOP-OF-LIST drag log:", raw);
    console.log(
      "[probe] TOP-OF-LIST patches:",
      JSON.stringify(outcome.patches),
    );
    console.log(
      `[probe] TOP-OF-LIST source before=${before.status} after=${after.status}`,
    );

    const dragoverCount = outcome.log.filter(
      (e) => e.type === "dragover",
    ).length;
    const dropCount = outcome.log.filter((e) => e.type === "drop").length;
    expect(
      outcome.handover,
      `browser never claimed the drag (abort signature). log=${raw}`,
    ).toBe(true);
    expect(
      dragoverCount,
      `expected dragover events. log=${raw}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      dropCount,
      `expected a drop event. log=${raw}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      after.status,
      `drop must have persisted a status change. log=${raw}`,
    ).toBe("in-progress");
  });

  it("survives a real drag while the list is scrolled (scroll pressure)", async () => {
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patches.push(req.url());
    });

    await openListView();

    const scrollInfo = await page.evaluate(() => {
      const el = document.getElementById("kanban-list-view")!;
      el.scrollTop = el.scrollHeight; // scroll to the bottom
      return {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    });
    console.log("[probe] scrolled to:", JSON.stringify(scrollInfo));
    await page.waitForTimeout(200);
    await tagRowsWithGroupStatus(page);

    const rows = await listRowRects(page);
    console.log(
      "[probe] scrolled visible rows:",
      JSON.stringify(rows.map((r) => ({ id: r.id, status: r.status }))),
    );
    expect(
      rows.length,
      "expected visible rows after scrolling",
    ).toBeGreaterThanOrEqual(3);

    const source = rows[2];
    const targetRow = rows[0];

    // Harness guard: the pointer must land on the draggable source row, not on a
    // clipped neighbour or an overlay. A miss here is a harness bug, not a bug
    // in the component, so fail before drawing any conclusion.
    const under = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        const draggable = el?.closest<HTMLElement>("[draggable]");
        return {
          elTag: el?.tagName ?? null,
          draggableAttr: draggable?.getAttribute("draggable") ?? null,
          draggableTaskId: draggable?.dataset.taskId ?? null,
        };
      },
      { id: source.id, x: source.x, y: source.top + source.height / 2 },
    );
    console.log(
      "[probe] scrolled source under pointer:",
      JSON.stringify(under),
    );
    expect(
      under.draggableTaskId,
      "pointer must start on the draggable source row",
    ).toBe(source.id);

    const before = await getTask(source.id);
    const outcome = await realDrag(
      page,
      source,
      { x: targetRow.x, y: targetRow.top + targetRow.height / 2 },
      patches,
    );
    const after = await getTask(source.id);

    const raw = JSON.stringify(outcome.log);
    console.log("[probe] SCROLLED drag log:", raw);
    console.log("[probe] SCROLLED patches:", JSON.stringify(outcome.patches));
    console.log(
      `[probe] SCROLLED source before=${before.status} after=${after.status}`,
    );

    const dragoverCount = outcome.log.filter(
      (e) => e.type === "dragover",
    ).length;
    const dropCount = outcome.log.filter((e) => e.type === "drop").length;
    expect(
      outcome.handover,
      `browser never claimed the drag (abort signature). log=${raw}`,
    ).toBe(true);
    expect(
      dragoverCount,
      `expected dragover events. log=${raw}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      dropCount,
      `expected a drop event. log=${raw}`,
    ).toBeGreaterThanOrEqual(1);
  });
});
