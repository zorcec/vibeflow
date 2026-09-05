/**
 * Playwright e2e tests for Batch B UI features: compact kanban view (B2)
 * and fit-screen +N more indicator (B3).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";

const PORT = 3932;
const BASE = `http://localhost:${PORT}`;
const API = `http://localhost:${PORT}/api/tasks`;

async function seedTask(
  title: string,
  status: string,
  description?: string,
  tags?: string[],
): Promise<string> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      description: description ?? `Description of ${title}`,
      selector: "/",
      status,
      ...(tags ? { tags } : {}),
    }),
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { id?: string; task?: { id?: string } };
  return body.id ?? body.task?.id ?? "";
}

describe("Batch B — view modes + fit-screen (compact view)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-batchb-pw-"));
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
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("compact view: three switches, one-line done-style rows, no strikethrough on open lanes", async () => {
    const taggedId = await seedTask(
      "COMPACT-desc-task",
      "todo",
      "COMPACT-MARKER-DESCRIPTION-XYZ",
      ["COMPACT-TAG-XYZ"],
    );
    // One comment → comment count badge in board view.
    await fetch(`${API}/${encodeURIComponent(taggedId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "pw", text: "compact count probe" }),
    });
    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
    // Three view switches: board | compact | list
    expect(await page.locator('[title="Board view"]').count()).toBe(1);
    expect(await page.locator('[title="Compact view"]').count()).toBe(1);
    expect(await page.locator('[title="List view"]').count()).toBe(1);
    // Board view renders full cards with descriptions
    await page.click('[title="Board view"]');
    await page.waitForFunction(
      () =>
        (document.body.textContent ?? "").includes(
          "COMPACT-MARKER-DESCRIPTION-XYZ",
        ),
      { timeout: 5_000 },
    );
    // Compact view: one-line rows, description hidden
    await page.click('[title="Compact view"]');
    await page.waitForSelector("article.task-card[data-compact]");
    await page.waitForFunction(
      () =>
        !(document.body.textContent ?? "").includes(
          "COMPACT-MARKER-DESCRIPTION-XYZ",
        ),
      { timeout: 5_000 },
    );
    // Compact rows: title only — no tags, no comment/file counts.
    const compactMeta = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll("article.task-card[data-compact]"),
      ).some((card) => {
        const text = card.textContent ?? "";
        return (
          text.includes("COMPACT-TAG-XYZ") ||
          text.includes("\uD83D\uDCAC") ||
          text.includes("\uD83D\uDCCE")
        );
      }),
    );
    expect(compactMeta).toBe(false);
    // Open-lane compact rows must not be struck through
    const struck = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          "article.task-card[data-compact] span",
        ),
      ).filter((el) =>
        getComputedStyle(el).textDecorationLine.includes("line-through"),
      ).length,
    );
    expect(struck).toBe(0);
  });

  // Owner rule: fit-to-screen applies to the DONE lane only. Other lanes
  // render every card with normal scrolling.
  it("fit-screen hides overflowing DONE cards behind a +N more chip", async () => {
    for (let i = 0; i < 14; i++) {
      await seedTask(`FITSCREEN-DONE-${i}`, "done");
    }
    await page.setViewportSize({ width: 1440, height: 640 });
    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
    await page.waitForFunction(() => {
      const column = document.querySelector("[data-column-id='done']");
      const cards = column?.querySelectorAll("article.task-card").length ?? 0;
      const chip = column?.querySelector("[data-fit-chip]");
      const hidden = Number(chip?.textContent?.match(/\+(\d+) more/)?.[1] ?? 0);
      return cards >= 1 && cards + hidden >= 14;
    }, { timeout: 10_000 });
    // Allow the fit-screen effect + ResizeObserver to settle
    await page.waitForTimeout(600);

    const chipText = await page.evaluate(() => {
      const chip = document.querySelector(
        "[data-column-id='done'] [data-fit-chip]",
      );
      return chip?.textContent ?? null;
    });
    expect(chipText).toMatch(/\+\d+ more/);

    const hiddenBefore = await page.evaluate(
      () =>
        document.querySelectorAll("[data-column-id='done'] [data-fit-chip]")
          .length,
    );
    expect(hiddenBefore).toBe(1);

    // Five data updates must not imperatively mutate card display styles.
    let displayFlips = 0;
    for (let i = 0; i < 5; i++) {
      await seedTask(`STABILITY-${i}`, "todo");
      await page.reload();
      await page.waitForSelector("#kanban-board");
      displayFlips += await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const snapshot = new Map<string, string>();
            let flips = 0;
            const recordDisplays = () => {
              document
                .querySelectorAll<HTMLElement>("[data-task-id]")
                .forEach((card) => {
                  const key = card.getAttribute("data-task-id") ?? "";
                  const display = card.style.display;
                  if (snapshot.has(key) && snapshot.get(key) !== display) {
                    flips += 1;
                  }
                  snapshot.set(key, display);
                });
            };
            recordDisplays();
            const observer = new MutationObserver(recordDisplays);
            observer.observe(document.body, {
              attributes: true,
              attributeFilter: ["style"],
              childList: true,
              subtree: true,
            });
            window.setTimeout(() => {
              observer.disconnect();
              resolve(flips);
            }, 800);
          }),
      );
    }
    expect(displayFlips).toBe(0);

    // Taller viewport → fewer hidden cards (chip shrinks or disappears)
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.waitForTimeout(600);
    const chipAfter = await page.evaluate(() => {
      const chip = document.querySelector(
        "[data-column-id='done'] [data-fit-chip]",
      );
      return chip?.textContent ?? null;
    });
    if (chipText && chipAfter) {
      const n = (s: string) => Number(s.match(/\+(\d+) more/)?.[1] ?? 0);
      expect(n(chipAfter)).toBeLessThanOrEqual(n(chipText));
    }
  });

  it("non-done lanes render ALL cards and keep scrolling (no chip)", async () => {
    for (let i = 0; i < 20; i++) {
      await seedTask(`FULLRENDER-${i}`, "todo");
    }
    await page.setViewportSize({ width: 1440, height: 640 });
    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
    await page.waitForTimeout(800);
    // Seeded so far in todo: COND-desc-task (1) + STABILITY-* (5) + FULLRENDER-* (20)
    const report = await page.evaluate(() => {
      const column = document.querySelector<HTMLElement>(
        "[data-column-id='todo'] .column-scroll",
      );
      const cards = document.querySelectorAll(
        "[data-column-id='todo'] [data-task-id]",
      ).length;
      const chip = document.querySelector(
        "[data-column-id='todo'] [data-fit-chip]",
      );
      let scrolled = false;
      if (column && column.scrollHeight > column.clientHeight + 1) {
        column.scrollTop = column.scrollHeight;
        scrolled = column.scrollTop > 0;
      }
      return { cards, chip: !!chip, scrolled };
    });
    expect(report.cards).toBe(26);
    expect(report.chip).toBe(false);
    expect(report.scrolled).toBe(true);
  });
});
