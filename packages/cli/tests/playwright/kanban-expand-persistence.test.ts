/**
 * Playwright e2e — per-user card expand/collapse persistence + unread dot.
 *
 * Acceptance covered here (CLI kanban surface):
 *  - Expanding a card and reloading the page keeps it expanded
 *    (state comes from the persisted task.expandedBy, not component state).
 *  - State is per user: switching the board's user id shows the card collapsed.
 *  - The blue unread dot renders only for tasks the current user has not opened
 *    and clears once the card is opened.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import { getCurrentUserId, findTaskFilePath } from "../../src/core/tasks.js";
import { writeConfig } from "../../src/core/config.js";

const PORT = 3981;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api/tasks`;

let tempDir: string;
let instance: ServeInstance;
let browser: Browser;
let page: Page;

interface TaskRef {
  id: string;
  title: string;
}

async function createTask(
  title: string,
  links?: Array<{ taskId: string; type: string }>,
): Promise<TaskRef> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, selector: "/", links }),
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { task: { id: string } };
  return { id: body.task.id, title };
}

function persistedTask(id: string) {
  return JSON.parse(readFileSync(findTaskFilePath(tempDir, id)!, "utf-8")) as {
    expandedBy?: string[];
    openedBy?: string[];
  };
}

async function gotoBoard() {
  await page.goto(`${BASE}/kanban`);
  await page.waitForSelector("#kanban-board article.task-card", {
    timeout: 15_000,
  });
}

function cardSelector(taskId: string) {
  return `[data-task-id="${taskId}"]`;
}

describe("kanban per-user expand state (CLI)", () => {
  beforeAll(async () => {
    process.env.USER = "expand-user-a";
    tempDir = mkdtempSync(join(tmpdir(), "vibeflow-expand-"));
    writeConfig(tempDir, { mode: "attach", port: PORT });
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
      _testToken: null,
      _testWorkspace: null,
    });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps a card expanded across a reload and collapses it for another user", async () => {
    const parent = await createTask("Parent with children");
    await createTask("Child of parent", [{ taskId: parent.id, type: "parent" }]);

    await gotoBoard();
    const chip = page.locator(`${cardSelector(parent.id)} [data-role="children-toggle"]`);
    const zone = page.locator(`${cardSelector(parent.id)} [data-role="children-block"]`);
    await expect.poll(() => chip.getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => zone.getAttribute("data-expanded")).toBe("false");

    await chip.click();
    await expect.poll(() => zone.getAttribute("data-expanded")).toBe("true");
    await expect
      .poll(() => persistedTask(parent.id).expandedBy)
      .toEqual([getCurrentUserId()]);

    // Reload → the expanded state must be re-derived from the task payload.
    await gotoBoard();
    await expect.poll(() => chip.getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => zone.getAttribute("data-expanded")).toBe("true");

    // A different user id (the board injects the server's user id) sees it collapsed.
    process.env.USER = "expand-user-b";
    await gotoBoard();
    await expect.poll(() => chip.getAttribute("aria-expanded")).toBe("false");
    // …and that user's own expansion is recorded alongside the first user's.
    await chip.click();
    await expect.poll(() => persistedTask(parent.id).expandedBy).toEqual([
      "expand-user-a",
      "expand-user-b",
    ]);

    // Back to user A — still expanded (its own state, not user B's).
    process.env.USER = "expand-user-a";
    await gotoBoard();
    await expect.poll(() => chip.getAttribute("aria-expanded")).toBe("true");
  }, 60_000);

  it("shows the unread dot only until the card is opened", async () => {
    process.env.USER = "expand-user-a";
    const task = await createTask("Unopened card");
    await gotoBoard();

    const dot = page.locator(`${cardSelector(task.id)} span[title="Unread"]`);
    await expect.poll(() => dot.count()).toBe(1);

    // Opening the card marks it opened for the current user (board → API).
    await page.evaluate((taskId) => {
      (
        document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement
      ).click();
    }, task.id);
    await page.waitForSelector("#detail-panel.open");
    await expect
      .poll(() => persistedTask(task.id).openedBy)
      .toEqual(["expand-user-a"]);
    await expect.poll(() => dot.count()).toBe(0);
  }, 60_000);
});
