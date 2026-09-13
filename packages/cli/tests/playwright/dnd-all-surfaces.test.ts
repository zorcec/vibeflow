/**
 * Test all DnD surfaces with direct event dispatch.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3714;
const BASE = `http://localhost:${PORT}`;
const API = `http://localhost:${PORT}/api/tasks`;

async function createTask(body: Record<string, unknown>) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selector: "#probe", ...body }),
  });
  const j = (await r.json()) as { task?: { id: string } };
  if (!j.task) throw new Error(`create failed: ${JSON.stringify(j)}`);
  return j.task.id;
}

async function getTask(id: string) {
  const r = await fetch(`${API}/${id}`);
  return (await r.json()) as {
    sortKey?: string;
    status?: string;
    links?: { taskId: string; type: string }[];
  };
}

async function dispatchDrag(
  page: Page,
  sourceId: string,
  targetSelector: string,
  targetPosition: { x: number; y: number },
  targetIsColumn = false,
) {
  return page.evaluate(
    async (args) => {
      const { sourceId, targetSelector, targetPosition, targetIsColumn } = args;
      const source = document.querySelector(
        `article[data-task-id="${sourceId}"]`,
      ) as HTMLElement;
      const target = document.querySelector(targetSelector) as HTMLElement;

      if (!source || !target) {
        return {
          error: "Elements not found",
          source: !!source,
          target: !!target,
        };
      }

      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();

      const dt = new DataTransfer();
      dt.setData("text/plain", sourceId);
      dt.effectAllowed = "move";

      // dragstart
      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: sourceRect.x + sourceRect.width / 2,
          clientY: sourceRect.y + sourceRect.height / 2,
        }),
      );

      // dragover on target
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: targetRect.x + targetPosition.x,
          clientY: targetRect.y + targetPosition.y,
        }),
      );

      // drop on column (parent)
      const column = targetIsColumn
        ? target
        : (target.closest("[data-column-id]") as HTMLElement);
      if (!column) return { error: "Column not found" };

      column.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: targetRect.x + targetPosition.x,
          clientY: targetRect.y + targetPosition.y,
        }),
      );

      // dragend
      source.dispatchEvent(
        new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );

      return { success: true };
    },
    { sourceId, targetSelector, targetPosition, targetIsColumn },
  );
}

describe("DnD all surfaces", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "dnd-all-"));
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();
  }, 30000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close?.();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("Surface 1: card → different column", async () => {
    const t1 = await createTask({
      title: "CROSS-COL",
      status: "todo",
      sortKey: "0000000001000000",
    });

    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patches.push(req.postData() || "");
    });

    await page.goto(`${BASE}/kanban`, {
      waitUntil: "networkidle",
      timeout: 10000,
    });
    await page.waitForSelector("#kanban-board", { timeout: 5000 });
    await page.waitForFunction(
      (id) =>
        !!document.querySelector(
          `[data-column-id="todo"] article[data-task-id="${id}"]`,
        ),
      t1,
      { timeout: 5000 },
    );

    const result = await dispatchDrag(
      page,
      t1,
      '[data-column-id="in-progress"]',
      { x: 100, y: 200 },
      true,
    );
    console.log("Cross-column result:", result);
    await page.waitForTimeout(1000);

    const after = await getTask(t1);
    console.log("Task after:", after);
    console.log("Patches:", patches);

    expect(after.status).toBe("in-progress");
  }, 30000);

  it("Surface 2: card → reorder within same column (top edge)", async () => {
    const r1 = await createTask({
      title: "REORDER-A",
      status: "todo",
      sortKey: "0000000010000000",
    });
    const r2 = await createTask({
      title: "REORDER-B",
      status: "todo",
      sortKey: "0000000020000000",
    });
    const r3 = await createTask({
      title: "REORDER-C",
      status: "todo",
      sortKey: "0000000030000000",
    });

    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patches.push(req.postData() || "");
    });

    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    await page.waitForSelector("#kanban-board", { timeout: 5000 });
    await page.waitForFunction(
      (ids) =>
        ids.every((id) =>
          document.querySelector(
            `[data-column-id="todo"] article[data-task-id="${id}"]`,
          ),
        ),
      [r1, r2, r3],
      { timeout: 5000 },
    );

    const orderBefore = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-column-id="todo"] article[data-task-id]',
        ),
      ].map((e) => (e.textContent ?? "").trim().slice(0, 15)),
    );

    const result = await dispatchDrag(
      page,
      r3,
      `article[data-task-id="${r1}"]`,
      { x: 140, y: 3 },
    );
    console.log("Reorder result:", result);
    await page.waitForTimeout(1000);

    const orderAfter = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          '[data-column-id="todo"] article[data-task-id]',
        ),
      ].map((e) => (e.textContent ?? "").trim().slice(0, 15)),
    );
    console.log("Order before:", orderBefore);
    console.log("Order after:", orderAfter);
    console.log("Patches:", patches);

    expect(orderAfter[0]).toContain("REORDER-C");
  }, 30000);

  it("Surface 3: card → column background (append to bottom)", async () => {
    const b1 = await createTask({
      title: "BG-TEST",
      status: "todo",
      sortKey: "0000000040000000",
    });

    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patches.push(req.postData() || "");
    });

    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    await page.waitForSelector("#kanban-board", { timeout: 5000 });
    await page.waitForFunction(
      (id) =>
        !!document.querySelector(
          `[data-column-id="todo"] article[data-task-id="${id}"]`,
        ),
      b1,
      { timeout: 5000 },
    );

    const result = await dispatchDrag(
      page,
      b1,
      '[data-column-id="done"] .column-scroll',
      { x: 100, y: 300 },
      true,
    );
    console.log("Column-bg result:", result);
    await page.waitForTimeout(1000);

    const after = await getTask(b1);
    console.log("Task after:", after);
    console.log("Patches:", patches);

    expect(after.status).toBe("done");
  }, 30000);

  it("Surface 4: card → make child (center drop)", async () => {
    const parent = await createTask({
      title: "PARENT",
      status: "todo",
      sortKey: "0000000050000000",
    });
    const child = await createTask({
      title: "CHILD",
      status: "todo",
      sortKey: "0000000060000000",
    });

    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH") patches.push(req.postData() || "");
    });

    await page.reload({ waitUntil: "networkidle", timeout: 10000 });
    await page.waitForSelector("#kanban-board", { timeout: 5000 });
    await page.waitForFunction(
      (ids) =>
        ids.every((id) =>
          document.querySelector(
            `[data-column-id="todo"] article[data-task-id="${id}"]`,
          ),
        ),
      [parent, child],
      { timeout: 5000 },
    );

    // Drop on center of parent card
    const parentRect = await page
      .locator(`article[data-task-id="${parent}"]`)
      .boundingBox();
    if (!parentRect) throw new Error("Parent not found");
    console.log("Parent card height:", parentRect.height);

    const result = await dispatchDrag(
      page,
      child,
      `article[data-task-id="${parent}"]`,
      { x: 140, y: parentRect.height / 2 },
    );
    console.log("Make-child result:", result);
    await page.waitForTimeout(1000);

    const after = await getTask(child);
    console.log("Child after:", after);
    console.log("Patches:", patches);

    // A centre drop links the dragged task as a child: the PATCH carries a
    // `links` field with a parent link pointing at the target card.
    expect(after.links ?? []).toContainEqual({
      taskId: parent,
      type: "parent",
    });
  }, 30000);
});
