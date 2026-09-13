/**
 * Verify element-diff symmetry e2e — real chromium, real `verifyTask` run.
 *
 * Annotation captures the element baseline with only `RELEVANT_STYLES`
 * (62 properties), but `captureSnapshot()` during verify used to enumerate ALL
 * computed styles (~609 in chromium). `computeDiff` unioned both key sets, so
 * every property recorded only in the after snapshot surfaced as a
 * `"" -> value` "change": a no-op page reported hundreds of style changes,
 * burying the real ones.
 *
 * These tests drive the real `verifyTask` against a live page:
 *   - no-op page            -> ZERO style changes
 *   - one property changed  -> exactly ONE style change
 *
 * The no-op case fails loudly on the pre-fix code (it reported ~547 changes),
 * so the assertion cannot pass vacuously.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyTask } from "../../src/commands/verify.js";
import { filterStyles, RELEVANT_STYLES } from "../../src/core/page-selector.js";
import type { DomSnapshot } from "../../src/core/verification-types.js";

const TASK_ID = "e2e-diff-symmetry";
const SELECTOR = ".submit";
const BACKGROUND_INITIAL = "rgb(37, 99, 235)";
const BACKGROUND_CHANGED = "rgb(220, 38, 38)";

let server: Server;
let baseUrl: string;
let browser: Browser;
let projectDir: string;

/**
 * Mutable page source. Flipping `background` between the baseline capture and
 * the verify run is the single real change the "one property" case asserts.
 */
let background = BACKGROUND_INITIAL;

function pageHtml(): string {
  return `<!doctype html>
<html>
  <head><style>
    .submit { background: ${background}; color: rgb(255, 255, 255); font-size: 14px; padding: 8px 16px; border: 1px solid rgb(0, 0, 0); }
  </style></head>
  <body><button class="submit">Submit</button></body>
</html>`;
}

/** Build the annotation-style baseline (shared RELEVANT_STYLES projection). */
async function captureAnnotationBaseline(): Promise<DomSnapshot> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });

  const locator = page.locator(SELECTOR).first();
  const computedStyles = await locator.evaluate(filterStyles, RELEVANT_STYLES);
  const outerHTML = await locator.evaluate((el) => el.outerHTML);
  const box = await locator.boundingBox();
  const browserString = await page.evaluate(() => navigator.userAgent);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));

  await context.close();

  return {
    outerHTML,
    computedStyles,
    selector: SELECTOR,
    position: {
      boundingBox: box ?? { x: 0, y: 0, width: 0, height: 0 },
      scrollPosition: { x: 0, y: 0 },
      viewport,
      stackingContext: { zIndex: "auto", position: "static" },
    },
    browser: browserString,
    consoleErrors: [],
    capturedAt: new Date().toISOString(),
  };
}

/** Write a minimal task with an inline annotation baseline. */
function writeTask(baseline: DomSnapshot): void {
  const tasksDir = join(projectDir, ".vibeflow", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `${TASK_ID}.json`),
    JSON.stringify(
      {
        id: TASK_ID,
        title: "diff symmetry e2e",
        description: "no-op and single-property style diff",
        status: "in-progress",
        url: baseUrl,
        selector: SELECTOR,
        cssSelector: SELECTOR,
        created: new Date().toISOString(),
        baseline,
      },
      null,
      2,
    ),
  );
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pageHtml());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind test http server");
  }
  baseUrl = `http://127.0.0.1:${address.port}/`;

  browser = await chromium.launch();
  projectDir = mkdtempSync(join(tmpdir(), "vibeflow-diff-symmetry-"));
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(projectDir, { recursive: true, force: true });
});

describe("verify element diff symmetry (real chromium)", () => {
  it("captures the after snapshot with exactly the shared RELEVANT_STYLES keys", async () => {
    background = BACKGROUND_INITIAL;
    writeTask(await captureAnnotationBaseline());

    const result = await verifyTask(projectDir, TASK_ID);

    expect(result.diff.selectorResolves).toBe(true);
    expect(Object.keys(result.after.snapshot.computedStyles).sort()).toEqual(
      [...RELEVANT_STYLES].sort(),
    );
  });

  it("reports ZERO style changes when the page is unchanged", async () => {
    background = BACKGROUND_INITIAL;
    writeTask(await captureAnnotationBaseline());

    const result = await verifyTask(projectDir, TASK_ID);

    const count = Object.keys(result.diff.stylesChanged).length;
    // Before the fix this was ~547 ("" -> value for every after-only property).
    console.log(
      `[diff-symmetry] no-op style changes reported: ${count} (expected 0)`,
    );
    expect(result.diff.stylesChanged).toEqual({});
  });

  it("reports exactly ONE change when exactly one property changes", async () => {
    background = BACKGROUND_INITIAL;
    writeTask(await captureAnnotationBaseline());

    background = BACKGROUND_CHANGED;
    const result = await verifyTask(projectDir, TASK_ID);

    const count = Object.keys(result.diff.stylesChanged).length;
    console.log(
      `[diff-symmetry] single-change style changes reported: ${count} (expected 1)`,
    );
    expect(Object.keys(result.diff.stylesChanged)).toEqual([
      "background-color",
    ]);
    expect(result.diff.stylesChanged["background-color"]).toEqual([
      BACKGROUND_INITIAL,
      BACKGROUND_CHANGED,
    ]);
  });
});
