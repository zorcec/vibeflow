/**
 * Real-pointer regression test for task eeb96429 — "a parented task never
 * renders in its own status column".
 *
 * The board rendered columns from `groupTasksByRoot(...).standalone`, and
 * `standalone` only ever contained tasks that are their OWN root. A task with a
 * parent therefore appeared ONLY as a child row inside its parent's card, i.e.
 * in whatever column the ROOT's status put it — invisible in the column
 * matching its own status. That is the real-world harm: `tasks --status` and
 * `tasks --next` filter on the task's own status and hand such a child out as
 * claimable work, while the board concealed it.
 *
 * Columns are now a view of STATUS (every task renders in the column matching
 * its own status) and the children tree stays a view of the RELATION.
 *
 * Real pointer input only: `page.mouse` press/move/release, and reachability is
 * judged by `document.elementFromPoint` at the card's own centre.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3981;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/tasks`;

/** Cap for a mouse move the browser may hold while claiming the drag. */
const DRAG_HANDOVER_MS = 4000;

describe("parented task renders in its own status column (eeb96429)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;
  let parentId: string;
  let childId: string;
  let grandchildId: string;

  async function createTask(body: Record<string, unknown>): Promise<string> {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selector: "#parented-column", ...body }),
    });
    const j = (await r.json()) as { task?: { id: string } };
    if (!j.task) throw new Error(`create failed: ${JSON.stringify(j)}`);
    return j.task.id;
  }

  async function statusOf(id: string): Promise<string> {
    const r = await fetch(`${API}/${id}`);
    const j = (await r.json()) as { status?: string };
    return j.status ?? "";
  }

  /** Cards rendered in a column, in board order. */
  async function columnCardIds(colId: string): Promise<string[]> {
    return page.evaluate(
      (cid) =>
        [
          ...document.querySelectorAll<HTMLElement>(
            `#kanban-board [data-column-id="${cid}"] article.task-card`,
          ),
        ].map((el) => el.dataset.taskId ?? ""),
      colId,
    );
  }

  /** Is this card the top-most element at its own centre — visible AND clickable? */
  async function cardReachable(id: string) {
    return page.evaluate((taskId) => {
      const el = document.querySelector<HTMLElement>(
        `article.task-card[data-task-id="${taskId}"]`,
      );
      if (!el) return { inDom: false };
      const r = el.getBoundingClientRect();
      const centre = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return {
        inDom: true,
        topIsSelf: !!centre?.closest(`article.task-card[data-task-id="${taskId}"]`),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      };
    }, id);
  }

  async function moveWithHandover(x: number, y: number): Promise<boolean> {
    return Promise.race([
      page.mouse.move(x, y).then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), DRAG_HANDOVER_MS),
      ),
    ]);
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "parented-column-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    // Root in backlog, its child in todo, a grandchild in review — every
    // status differs from its root's, which is the reported shape.
    parentId = await createTask({
      title: "PARENT IN BACKLOG",
      status: "backlog",
      sortKey: "0000000000000001",
    });
    childId = await createTask({
      title: "CHILD IN TODO",
      status: "todo",
      sortKey: "0000000000000002",
      links: [{ taskId: parentId, type: "parent" }],
    });
    grandchildId = await createTask({
      title: "GRANDCHILD IN REVIEW",
      status: "review",
      sortKey: "0000000000000003",
      links: [{ taskId: childId, type: "parent" }],
    });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
  }, 60000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("renders the child in its own column, not only inside its parent", async () => {
    await page.goto(`${BASE}/kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#kanban-board", { timeout: 15000 });
    await page.waitForFunction(
      (id) =>
        !!document.querySelector(`article.task-card[data-task-id="${id}"]`),
      childId,
      { timeout: 15000 },
    );

    expect(await columnCardIds("todo")).toEqual([childId]);
    expect(await columnCardIds("backlog")).toEqual([parentId]);
    expect(await columnCardIds("review")).toEqual([grandchildId]);

    // The parent keeps its children tree (relation view, not regressed).
    const parentTree = await page.evaluate((id) => {
      const card = document.querySelector<HTMLElement>(
        `article.task-card[data-task-id="${id}"]`,
      );
      return {
        childRows: card
          ? [...card.querySelectorAll("[data-role='child-link-row']")].map(
              (row) => row.getAttribute("data-task-id"),
            )
          : [],
        column: card?.closest("[data-column-id]")?.getAttribute("data-column-id"),
      };
    }, parentId);
    expect(parentTree.column).toBe("backlog");
    expect(parentTree.childRows).toContain(childId);
  }, 60000);

  it("makes the child card visible and clickable where it renders", async () => {
    const reach = await cardReachable(childId);
    expect(reach.inDom).toBe(true);
    expect(
      reach.topIsSelf,
      `the child card must be reachable, not buried: ${JSON.stringify(reach)}`,
    ).toBe(true);

    // Opening it with a real pointer must open THAT task, not its parent.
    const centre = reach.rect!;
    await page.mouse.move(centre.x + centre.w / 2, centre.y + centre.h / 2);
    await page.waitForTimeout(60);
    await page.mouse.down();
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForSelector("#detail-panel-container", { timeout: 10000 });
    await page.waitForFunction(
      () =>
        (document.getElementById("detail-panel-container")?.textContent ?? "")
          .length > 0,
      undefined,
      { timeout: 10000 },
    );
    const panelText = await page.evaluate(
      () => document.getElementById("detail-panel-container")?.textContent ?? "",
    );
    // The panel's ID field carries the full task id; the title lives in an input
    // value, which textContent does not expose.
    expect(panelText).toContain(childId);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }, 60000);

  it("can move the child to another column with a real pointer drag", async () => {
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patches.push(req.url());
    });

    const card = await page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(
        `article.task-card[data-task-id="${id}"]`,
      );
      if (!el) throw new Error("child card not found");
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, childId);
    const target = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(
        '#kanban-board [data-column-id="in-progress"] .column-header',
      );
      if (!header) throw new Error("in-progress column header not found");
      const r = header.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });

    await page.mouse.move(card.x, card.y);
    await page.mouse.down();
    const STEPS = 12;
    let handedOver = true;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const moved = await moveWithHandover(
        card.x + (target.x - card.x) * t,
        card.y + (target.y - card.y) * t,
      );
      if (!moved) {
        handedOver = false;
        break;
      }
      await page.waitForTimeout(20);
    }
    await Promise.race([
      page.mouse.up(),
      new Promise<void>((resolve) => setTimeout(resolve, DRAG_HANDOVER_MS)),
    ]);
    await page.waitForTimeout(800);

    expect(
      handedOver,
      `the browser never claimed the drag (patches=${JSON.stringify(patches)})`,
    ).toBe(true);
    expect(
      patches.some((url) => url.includes(`/api/tasks/${childId}`)),
      `expected a PATCH for the child card (patches=${JSON.stringify(patches)})`,
    ).toBe(true);
    expect(await statusOf(childId)).toBe("in-progress");
    // And it is now rendered in the column it was dragged to.
    expect(await columnCardIds("in-progress")).toContain(childId);
  }, 60000);
});
