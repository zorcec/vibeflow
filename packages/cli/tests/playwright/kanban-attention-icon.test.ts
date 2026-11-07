/**
 * Needs-attention icon pin (ticket 0752d55c, pill → indicator restyle).
 *
 * Owner order: the marker must NOT look like a tag pill. Every surface —
 * card title row, child row, detail header — renders the same amber bell
 * icon (AttentionBadge) alongside its leading status/verify slot, at the
 * VerifyIndicator optical sizes (11 card + detail header, 10 tree row).
 * This spec pins all three surfaces at once and fails on any return of the
 * uppercase NEEDS ATTENTION pill text.
 *
 * Staleness guard: the kanban client bundle is inlined into the served HTML
 * at PROCESS START, so a board started before a rebuild serves pre-fix JS
 * forever. Fails loudly when dist is older than the sources or the served
 * bundle differs from disk — rebuild, then restart.
 *
 * Hermetic: seeds its own scratch project under /tmp (flagged root + flagged
 * child), serves it on its own port, kills the server afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { guardContext, type ErrorGuard } from "./error-guard";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import { createTask, writeTaskJson } from "../../src/core/tasks.js";

const PORT = 3962;
const BASE = `http://localhost:${PORT}`;

const STALE_DIST_MSG =
  "dist/client/kanban-browser.js is older than the newest kanban source " +
  "file. The Playwright suite would test a stale bundle and could lie about " +
  "the fix. Run `pnpm --filter @vibeflow-tools/cli run build` first.";

const STALE_SERVED_MSG =
  "board serves a stale inlined bundle — rebuild and restart the board " +
  "process. The kanban client bundle is inlined into the served HTML at " +
  "process start, so a board started before a build serves pre-fix JS " +
  "forever; a browser reload alone does not pick the fix up.";

function newestSourceMtime(root: string): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walk(full);
      } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  };
  walk(root);
  return newest;
}

describe("needs-attention renders as an icon on every surface (no pill)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;
  let rootTaskId: string;
  let childTaskId: string;
  let guard: ErrorGuard;

  beforeAll(async () => {
    const distBundle = "dist/client/kanban-browser.js";
    const distMtime = statSync(distBundle).mtimeMs;
    const srcNewest = Math.max(
      newestSourceMtime(join("src", "client", "kanban")),
      newestSourceMtime(join("..", "ui", "src", "kanban")),
      statSync(join("..", "ui", "src", "AttentionBadge.tsx")).mtimeMs,
    );
    expect(distMtime, STALE_DIST_MSG).toBeGreaterThanOrEqual(srcNewest);

    tempDir = mkdtempSync(join(tmpdir(), "attention-icon-pw-"));
    const root = createTask(tempDir, {
      title: "Flagged root task",
      description: "seeded by kanban-attention-icon.test.ts",
      selector: "/",
      type: "Task",
      status: "todo",
    });
    const child = createTask(tempDir, {
      title: "Flagged child task",
      description: "flagged child for the row pin",
      selector: "/",
      type: "Task",
      status: "todo",
      links: [{ taskId: root.id, type: "parent" }],
    });
    rootTaskId = root.id;
    childTaskId = child.id;
    writeTaskJson(tempDir, { ...root, needsAttention: true });
    writeTaskJson(tempDir, { ...child, needsAttention: true });

    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });

    const html = await (await fetch(`${BASE}/kanban`)).text();
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1],
    );
    const servedBundle = inlineScripts.find((s) => s.length > 10_000);
    expect(servedBundle, STALE_SERVED_MSG).toBeDefined();
    const diskBundle = readFileSync(distBundle, "utf-8");
    expect(servedBundle, STALE_SERVED_MSG).toBe(diskBundle);

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
    });
    page = await context.newPage();
    guard = guardContext(context);

    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
    await page.waitForSelector(
      `article.task-card[data-task-id="${rootTaskId}"]`,
      { timeout: 15_000 },
    );
  }, 60_000);

  afterEach(() => guard.assertNoErrors());

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("card title row renders the bell icon, not the pill", async () => {
    const sel = `article.task-card[data-task-id="${rootTaskId}"] [data-attention-state="flagged"]`;
    await page.waitForSelector(sel, { state: "visible", timeout: 8_000 });
    const probe = await page.$eval(
      sel,
      (el) => ({
        label: el.getAttribute("aria-label"),
        role: el.getAttribute("role"),
        title: el.getAttribute("title") ?? "",
        text: (el.textContent ?? "").trim(),
        hasSvg: !!el.querySelector("svg"),
      }),
    );
    expect(probe.label).toBe("Needs attention");
    expect(probe.role).toBe("img");
    expect(probe.title).toContain("activity feed");
    // Icon variant: a glyph, zero pill text.
    expect(probe.hasSvg).toBe(true);
    expect(probe.text).toBe("");
    // Breathing hook: the shared class drives the CSS-only pulse (real
    // browser computes the keyframes; unit pins the stylesheet itself).
    const animationName = await page.$eval(
      sel,
      (el) => getComputedStyle(el).animationName,
    );
    expect(animationName).toContain("attention-breathe");
  });

  it("child row renders the bell icon alongside the leading slot", async () => {
    const sel = `[data-role="child-link-row"][data-task-id="${childTaskId}"] [data-attention-state="flagged"]`;
    await page.waitForSelector(sel, { state: "visible", timeout: 8_000 });
    const probe = await page.$eval(sel, (el) => {
      const row = el.closest("[data-role='child-link-row']")!;
      const title = row.querySelector(".child-link-title")!;
      // Position of the title relative to the marker: FOLLOWING (4) means
      // the marker precedes the title — alongside the leading slot.
      const mask = el.compareDocumentPosition(title);
      return {
        text: (el.textContent ?? "").trim(),
        hasSvg: !!el.querySelector("svg"),
        titleFollows: (mask & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      };
    });
    expect(probe.hasSvg).toBe(true);
    expect(probe.text).toBe("");
    // Alongside the leading slot: the marker precedes the title text.
    expect(probe.titleFollows).toBe(true);
  });

  it("detail header renders the bell icon when the flagged card is opened", async () => {
    const panelOpen = page.waitForSelector("#detail-panel.open", {
      timeout: 8_000,
    });
    await page.click(
      `article.task-card[data-task-id="${rootTaskId}"] span[data-role="card-title"]`,
    );
    await panelOpen;
    const sel = `#dp-attention-row [data-attention-state="flagged"]`;
    await page.waitForSelector(sel, { state: "visible", timeout: 8_000 });
    const probe = await page.$eval(sel, (el) => ({
      text: (el.textContent ?? "").trim(),
      hasSvg: !!el.querySelector("svg"),
    }));
    expect(probe.hasSvg).toBe(true);
    expect(probe.text).toBe("");
    await page.click("#dp-close");
  });

  it("card bell click opens the detail panel directly on the activities tab", async () => {
    const panelOpen = page.waitForSelector("#detail-panel.open", {
      timeout: 8_000,
    });
    await page.click(
      `article.task-card[data-task-id="${rootTaskId}"] button[data-attention-press="true"]`,
    );
    await panelOpen;
    // Tab-targeted open: the reason tab, not the default details tab.
    await page.waitForSelector("#dp-tab-activity.active", {
      timeout: 8_000,
    });
    await page.click("#dp-close");
  });

  it("detail child-row bell click navigates to the child on the activities tab", async () => {
    // Open the flagged root on details, then take the CHILDREN group
    // bell — it navigates the same panel to the child, tab-targeted.
    const panelOpen = page.waitForSelector("#detail-panel.open", {
      timeout: 8_000,
    });
    await page.click(
      `article.task-card[data-task-id="${rootTaskId}"] span[data-role="card-title"]`,
    );
    await panelOpen;
    const childBell = `[data-role="relation-group-rows"] [data-role="child-link-row"][data-task-id="${childTaskId}"] button[data-attention-press="true"]`;
    await page.waitForSelector(childBell, {
      state: "visible",
      timeout: 8_000,
    });
    await page.click(childBell);
    // Same panel, now on the child task with the activities tab active
    // (the child is flagged too, so its header bell is still present).
    await page.waitForSelector("#dp-tab-activity.active", {
      timeout: 8_000,
    });
    await page.waitForSelector(
      `#dp-attention-row [data-attention-state="flagged"]`,
      { state: "visible", timeout: 8_000 },
    );
    await page.click("#dp-close");
  });

  it("no uppercase pill text exists anywhere on the board", async () => {
    // The old pill rendered "Needs attention" as text with CSS uppercase
    // (visually NEEDS ATTENTION). The icon variant keeps the words only in
    // title/aria-label — never as element text.
    const bodyText = await page.evaluate(() => document.body.innerText ?? "");
    expect(bodyText).not.toContain("NEEDS ATTENTION");
    const flaggedTexts = await page.$$eval(
      '[data-attention-state="flagged"]',
      (els) => els.map((el) => (el.textContent ?? "").trim()),
    );
    expect(flaggedTexts.length).toBeGreaterThan(0);
    for (const text of flaggedTexts) {
      expect(text).toBe("");
    }
  });
});
