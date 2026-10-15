/**
 * Playwright regression — child-popover (hover "tooltip") anchoring (CLI).
 *
 * A parent with many children used to open its hover popover pinned to the
 * viewport top (top: 8px): the height estimate counted every child while
 * only six rows render, so the flip-then-clamp logic fired on a phantom
 * height. These specs pin the popover's box relative to the chip's box:
 * adjacent (a few px gap, above or below) and fully inside the viewport,
 * including the near-right-edge case where horizontal clamping engages.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium } from "playwright";
import { guardPage, type ErrorGuard } from "./error-guard";
import type { Browser, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import { getFreePort } from "../ports.js";
import { writeConfig } from "../../src/core/config.js";

let PORT = 0;
let BASE = "";
let API = "";
let tempDir: string;
let instance: ServeInstance;
let browser: Browser;
let page: Page;
let guard: ErrorGuard;
let bigParentId = "";
let smallParentId = "";

async function createTask(body: object): Promise<string> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { task: { id: string } }).task.id;
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

async function hoverChip(taskId: string): Promise<{
  chip: Box;
  pop: Box;
  viewport: { w: number; h: number };
}> {
  const chip = page.locator(
    `[data-task-id="${taskId}"] [data-role="children-toggle"]`,
  );
  await chip.scrollIntoViewIfNeeded();
  await chip.hover();
  await page.locator("body > [data-role='child-popover']").waitFor({
    timeout: 10_000,
  });
  // Let the 0.12s entry animation settle before measuring boxes.
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const chipEl = document.querySelector(
      "[data-role='children-toggle']:hover",
    ) as HTMLElement | null;
    const popEl = document.querySelector(
      "body > [data-role='child-popover']",
    ) as HTMLElement | null;
    if (!chipEl || !popEl) throw new Error("chip or popover missing");
    const cr = chipEl.getBoundingClientRect();
    const pr = popEl.getBoundingClientRect();
    const box = (r: DOMRect): Box => ({
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
    });
    return {
      chip: box(cr),
      pop: box(pr),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });
}

describe("kanban child-popover anchoring (CLI)", () => {
  beforeAll(async () => {
    process.env.USER = "popover-anchor-user";
    tempDir = mkdtempSync(join(tmpdir(), "popover-anchor-"));
    PORT = await getFreePort();
    BASE = `http://localhost:${PORT}`;
    API = `${BASE}/api/tasks`;
    writeConfig(tempDir, { mode: "attach", port: PORT });
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
      _testToken: null,
      _testWorkspace: null,
    });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    guard = guardPage(page);
    // Push the parents toward the column bottom so flip/clamp paths engage.
    for (let i = 0; i < 5; i++) {
      await createTask({ title: `Anchor filler ${i}`, selector: "/", status: "review" });
    }
    bigParentId = await createTask({
      title: "Anchor parent 30",
      selector: "/",
      status: "review",
    });
    for (let i = 0; i < 30; i++) {
      await createTask({
        title: `Anchor kid ${i}`,
        selector: "/",
        links: [{ taskId: bigParentId, type: "parent" }],
      });
    }
    smallParentId = await createTask({
      title: "Anchor parent 2",
      selector: "/",
      status: "review",
    });
    for (let i = 0; i < 2; i++) {
      await createTask({
        title: `Anchor small kid ${i}`,
        selector: "/",
        links: [{ taskId: smallParentId, type: "parent" }],
      });
    }
    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board article.task-card", {
      timeout: 15_000,
    });
    // Columns strip to the right end: review sits at the right edge.
    await page.evaluate(() => {
      const strip = [...document.querySelectorAll("*")].find(
        (e) =>
          (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 50,
      ) as HTMLElement | undefined;
      if (strip) strip.scrollLeft = 999999;
    });
  });

  afterEach(() => guard.assertNoErrors());

  afterAll(async () => {
    await browser?.close();
    await instance?.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("a 30-child popover opens adjacent to its chip, inside the viewport", async () => {
    const { chip, pop, viewport } = await hoverChip(bigParentId);
    // Adjacent: 6px margin below the chip, or flipped just above it.
    const belowGap = pop.top - chip.bottom;
    const aboveGap = chip.top - pop.bottom;
    const adjacent =
      (belowGap >= 2 && belowGap <= 14) || (aboveGap >= 2 && aboveGap <= 260);
    expect(
      adjacent,
      `popover ${JSON.stringify(pop)} not adjacent to chip ${JSON.stringify(chip)}`,
    ).toBe(true);
    // Must NOT be pinned to the viewport top edge.
    expect(pop.top).toBeGreaterThan(24);
    // Fully inside the viewport (no overflow / clipping).
    expect(pop.top).toBeGreaterThanOrEqual(0);
    expect(pop.left).toBeGreaterThanOrEqual(0);
    expect(pop.right).toBeLessThanOrEqual(viewport.w);
    expect(pop.bottom).toBeLessThanOrEqual(viewport.h);
    // Horizontally anchored: overlaps the chip or clamps to the right edge.
    const overlapsChip = pop.left <= chip.right && pop.right >= chip.left;
    const clampedRight = viewport.w - pop.right <= 10;
    expect(overlapsChip || clampedRight).toBe(true);
  });

  it("a 2-child popover opens directly below its chip", async () => {
    const { chip, pop, viewport } = await hoverChip(smallParentId);
    const gap = pop.top - chip.bottom;
    expect(gap).toBeGreaterThanOrEqual(2);
    expect(gap).toBeLessThanOrEqual(14);
    // Left-aligned with the chip unless the viewport right edge clamps it;
    // either way it must overlap the chip horizontally and stay on-screen.
    expect(pop.left).toBeLessThanOrEqual(chip.left + 2);
    expect(pop.right).toBeGreaterThanOrEqual(chip.left);
    expect(pop.right).toBeLessThanOrEqual(viewport.w);
  });
});
