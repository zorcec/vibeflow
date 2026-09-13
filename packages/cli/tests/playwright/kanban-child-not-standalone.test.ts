/**
 * Regression test for the board's parent/child contract.
 *
 * OWNER DECISION: a task that has a parent must NOT be rendered as a standalone
 * card in the column matching its own status. It belongs to its parent — the
 * relationship is the only place a child appears on the board, and it shows as a
 * row inside its root's card. Its verify verdict shows on that child row, not on
 * a card of its own.
 *
 * This guards against the opposite model being reintroduced: rendering columns
 * from every task (`[...filtered].sort(compareTaskOrder)`) instead of from
 * `groupTasksByRoot(...).standalone` makes a child appear as a card in its own
 * column, which duplicates it and reads as the board "inventing" work.
 *
 * Real pointer input only: reachability is judged by `document.elementFromPoint`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3982;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/tasks`;

describe("a parented task is not a standalone card (parent/child view)", () => {
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
      body: JSON.stringify({ selector: "#child-contract", ...body }),
    });
    const j = (await r.json()) as { task?: { id: string } };
    if (!j.task) throw new Error(`create failed: ${JSON.stringify(j)}`);
    return j.task.id;
  }

  /** Every `data-task-id` rendered in a column, cards AND child rows. */
  async function columnTaskIds(colId: string): Promise<string[]> {
    return page.evaluate(
      (cid) =>
        [
          ...document.querySelectorAll<HTMLElement>(
            `#kanban-board [data-column-id="${cid}"] [data-task-id]`,
          ),
        ].map((el) => el.dataset.taskId ?? ""),
      colId,
    );
  }

  /** Standalone cards only — the thing a child must NOT be. */
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

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "child-not-standalone-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    // Root in backlog; its child in todo; a grandchild in review. Every status
    // differs from its root's, which is the shape that used to leak a child out
    // as its own card.
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
    await page.goto(`${BASE}/kanban`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#kanban-board", { timeout: 15000 });
    // Let the task list land and the tree resolve.
    await page.waitForFunction(
      () => document.querySelectorAll("article.task-card").length > 0,
      { timeout: 15000 },
    );
  }, 60000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does NOT render the child as a standalone card in its own column", async () => {
    // The parent is a root, so it IS a card — in ITS column (backlog).
    expect(await columnCardIds("backlog")).toEqual([parentId]);

    // The child's own column (todo) must NOT contain a card for it.
    expect(await columnCardIds("todo")).not.toContain(childId);
    // Nor the grandchild's column.
    expect(await columnCardIds("review")).not.toContain(grandchildId);

    // Stronger: nothing at all in the child's column — no card, no row.
    expect(await columnTaskIds("todo")).not.toContain(childId);
    expect(await columnTaskIds("review")).not.toContain(grandchildId);
  });

  it("renders the child as a row inside its parent's card", async () => {
    const tree = await page.evaluate((ids) => {
      const rowFor = (id: string) =>
        document.querySelector<HTMLElement>(
          `[data-role="child-link-row"][data-task-id="${id}"]`,
        );
      const cardFor = (id: string) =>
        document.querySelector<HTMLElement>(
          `article.task-card[data-task-id="${id}"]`,
        );
      const parentCard = cardFor(ids.parentId);
      const childRow = rowFor(ids.childId);
      const grandchildRow = rowFor(ids.grandchildId);
      const columnOf = (el: Element | null) =>
        (el?.closest("[data-column-id]") as HTMLElement | null)?.dataset
          .columnId ?? null;
      return {
        parentCardInColumn: columnOf(parentCard),
        parentCardContainsChildRow: !!parentCard?.contains(childRow ?? null),
        childRowInColumn: columnOf(childRow),
        childRowExists: !!childRow,
        grandchildRowExists: !!grandchildRow,
      };
    }, { parentId, childId, grandchildId });

    // The nesting itself is the requirement: the child exists only under the
    // parent, and both live in the parent's column.
    expect(tree.parentCardInColumn).toBe("backlog");
    expect(tree.childRowExists).toBe(true);
    expect(tree.parentCardContainsChildRow).toBe(true);
    expect(tree.childRowInColumn).toBe("backlog");
    // The grandchild is nested under the child, so it too is inside the tree.
    expect(tree.grandchildRowExists).toBe(true);
  });

  it("keeps the parent card visible and clickable at its own centre", async () => {
    const reach = await page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(
        `article.task-card[data-task-id="${id}"]`,
      );
      if (!el) return { inDom: false };
      const r = el.getBoundingClientRect();
      const centre = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return {
        inDom: true,
        topIsSelf: !!centre?.closest(`article.task-card[data-task-id="${id}"]`),
      };
    }, parentId);
    expect(reach.inDom).toBe(true);
    expect(reach.topIsSelf).toBe(true);

    // And the board did not "invent" work: the parent's own status column holds
    // exactly one card, not three.
    const backlogCards = await columnCardIds("backlog");
    expect(backlogCards).toEqual([parentId]);
  });
});
