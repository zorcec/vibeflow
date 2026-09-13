/**
 * Page-wide capture e2e — real chromium, real Playwright page boundary.
 *
 * `vibeflow verify` produces `verify-all-styles.json` by passing
 * `capturePageWideElements` to `page.evaluate()`. The original implementation
 * passed helper functions as ARGUMENTS to page.evaluate(); Playwright cannot
 * serialize functions, threw "Attempting to serialize unexpected value", and
 * the surrounding bare catch swallowed it — so verify-all-styles.json (and the
 * derived verify-page-diff.json) were never written.
 *
 * This spec runs the callback through a real browser and asserts a usable
 * snapshot is produced. The negative control reproduces the original
 * serialization error, so the positive assertion cannot pass vacuously.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { capturePageWideElements } from "../../src/commands/verify.js";
import { RELEVANT_STYLES } from "../../src/core/page-selector.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(`
    <div class="board" data-status="backlog">
      <article class="task-card" data-task-id="abc123">First task</article>
      <article class="task-card" data-task-id="def456">Second task</article>
    </div>
  `);
});

afterAll(async () => {
  await browser?.close();
});

describe("capturePageWideElements (real browser)", () => {
  it("produces the page-wide snapshot through page.evaluate", async () => {
    const snapshot = await page.evaluate(capturePageWideElements, {
      styles: RELEVANT_STYLES,
      maxElements: 1000,
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.truncated).toBe(false);
    expect(Object.keys(snapshot.elements).length).toBeGreaterThan(0);

    const elements = Object.values(snapshot.elements) as Array<
      Record<string, any>
    >;
    const card = elements.find((e) => e.dataAttrs?.["task-id"] === "abc123");

    expect(card).toBeDefined();
    expect(card!.selector).toContain("data-task-id=abc123");
    expect(card!.classes).toContain("task-card");
    expect(card!.text).toBe("First task");
    expect(Object.keys(card!.baseline)).toHaveLength(RELEVANT_STYLES.length);
  });

  it("negative control: a function argument still throws at the boundary", async () => {
    const buildKey = (el: Element) => el.tagName;
    const evaluateUnchecked = page.evaluate.bind(page) as unknown as (
      fn: (arg: unknown) => unknown,
      arg: unknown,
    ) => Promise<unknown>;

    await expect(
      evaluateUnchecked(
        (arg) => (arg as { fn: (el: Element) => string }).fn(document.body),
        { fn: buildKey },
      ),
    ).rejects.toThrow(/serialize/i);
  });
});
