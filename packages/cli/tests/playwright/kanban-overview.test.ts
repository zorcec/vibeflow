/**
 * Playwright tests for the CLI kanban overview page (ticket 717d6335).
 *
 * Seeds a board through the real task API, loads /overview in headless
 * chromium, and asserts the rendered numbers match the seed exactly —
 * a wrong seed (or a broken aggregator) goes red here with real pixels.
 * Also covers the board ↔ overview navigation links and the no-console-error
 * guard. READ-ONLY page: the test asserts no mutation endpoint is hit by
 * re-reading the task list afterwards (same length, same statuses).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import { guardContext, type ErrorGuard } from "./error-guard";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3945;
const BASE = `http://localhost:${PORT}`;

let browser: Browser;
let instance: ServeInstance;
let tempDir: string;

async function apiCreate(
  title: string,
  selector: string,
  status: string,
): Promise<{ id: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, selector, status }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`seed failed: ${res.status}`);
    const data = (await res.json()) as { task: { id: string } };
    return { id: data.task.id };
  } finally {
    clearTimeout(timer);
  }
}

async function apiPatch(id: string, body: Record<string, unknown>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BASE}/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`patch failed: ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

async function openOverview(): Promise<{
  context: BrowserContext;
  page: Page;
  guard: ErrorGuard;
}> {
  const context = await browser.newContext();
  const guard = guardContext(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/overview`);
  await page.waitForSelector("#overview-title", { timeout: 10_000 });
  await page.waitForSelector('[data-testid="overview-status-table"]', {
    timeout: 10_000,
  });
  return { context, page, guard };
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "vf-overview-pw-"));
  instance = await serve(undefined, {
    port: PORT,
    open: false,
    projectDir: tempDir,
  });
  // Seed: 1 backlog, 2 todo, 1 in-progress, 1 review, 1 done-today.
  await apiCreate("pw backlog", "/pw-a", "backlog");
  await apiCreate("pw todo one", "/pw-b", "todo");
  await apiCreate("pw todo two", "/pw-c", "todo");
  const wip = await apiCreate("pw wip", "/pw-d", "todo");
  await apiPatch(wip.id, { status: "in-progress" });
  // A review task: created directly in review via the create status path.
  await apiCreate("pw review", "/pw-e", "review");
  const done = await apiCreate("pw done", "/pw-f", "todo");
  await apiPatch(done.id, { status: "done" });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await instance?.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("kanban overview page", () => {
  it("renders exact status counts for the seeded board", async () => {
    const { context, page, guard } = await openOverview();
    try {
      const cell = (id: string) =>
        page.textContent(
          `[data-testid="overview-status-${id}"] td:last-child`,
        );
      expect(await cell("backlog")).toBe("1");
      expect(await cell("todo")).toBe("2");
      expect(await cell("in-progress")).toBe("1");
      expect(await cell("review")).toBe("1");
      expect(await cell("done")).toBe("1");
      expect(await page.textContent("#overview-status-heading")).toContain(
        "6 total",
      );
      guard.assertNoErrors();
    } finally {
      await context.close();
    }
  });

  it("shows done-today/this-week and the oldest open work with board links", async () => {
    const { context, page, guard } = await openOverview();
    try {
      expect(
        await page.textContent('[data-testid="overview-done-today"]'),
      ).toBe("1");
      expect(
        await page.textContent('[data-testid="overview-done-week"]'),
      ).toBe("1");
      const oldestTodo = page.locator('[data-testid="overview-oldest-todo"]');
      expect(await oldestTodo.textContent()).toContain("pw todo one");
      const href =
        (await oldestTodo.locator("a").first().getAttribute("href")) ?? "";
      expect(href).toMatch(/^\/kanban#task-[a-f0-9]+$/);
      const oldestWip = page.locator(
        '[data-testid="overview-oldest-in-progress"]',
      );
      expect(await oldestWip.textContent()).toContain("pw wip");
      guard.assertNoErrors();
    } finally {
      await context.close();
    }
  });

  it("links back to the board and the board links to the overview", async () => {
    const { context, page, guard } = await openOverview();
    try {
      await Promise.all([
        page.waitForURL("**/kanban", { timeout: 10_000 }),
        page.click("#overview-back-link"),
      ]);
      await page.waitForSelector("#kanban-board", { timeout: 10_000 });
      // The board header carries the return link.
      await page.click("#overview-btn");
      await page.waitForURL("**/overview", { timeout: 10_000 });
      await page.waitForSelector("#overview-title", { timeout: 10_000 });
      guard.assertNoErrors();
    } finally {
      await context.close();
    }
  });

  it("shows the assignee breakdown and mutates nothing", async () => {
    const { context, page, guard } = await openOverview();
    try {
      const table = page.locator('[data-testid="overview-assignee-table"]');
      await table.waitFor({ timeout: 10_000 });
      // Every seeded task shares the machine's git author — one row whose
      // total equals the whole board proves the breakdown aggregates it.
      const totals = await table
        .locator("tbody tr td:nth-child(2)")
        .allTextContents();
      const sum = totals.reduce((n, t) => n + Number(t.trim()), 0);
      expect(sum).toBe(6);
      guard.assertNoErrors();
    } finally {
      await context.close();
    }

    // Read-only proof: the task list is unchanged after viewing the page.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${BASE}/api/tasks`, {
        signal: controller.signal,
      });
      const data = (await res.json()) as { tasks: Array<{ status: string }> };
      expect(data.tasks).toHaveLength(6);
      const counts = new Map<string, number>();
      for (const t of data.tasks)
        counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
      expect(counts.get("todo")).toBe(2);
      expect(counts.get("done")).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  });
});
