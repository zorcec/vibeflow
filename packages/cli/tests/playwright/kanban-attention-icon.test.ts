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
  let preFlaggedTaskId: string;
  let plainTaskId: string;
  const COLD_REASON =
    "Blocked: awaiting design tokens for the empty state before build.";
  const PLAIN_NOTE = "Plain note on an unflagged task for style comparison.";
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
    // Cold-load gap pin: flagged BEFORE the board opens, with the reason
    // comment already in the file — no live transition will ever fire for
    // this task, so the feed must derive the row + tint from state alone.
    const preFlagged = createTask(tempDir, {
      title: "Pre-flagged task",
      description: "flagged before serve by kanban-attention-icon.test.ts",
      selector: "/",
      type: "Task",
      status: "todo",
    });
    preFlaggedTaskId = preFlagged.id;
    writeTaskJson(tempDir, {
      ...preFlagged,
      needsAttention: true,
      comments: [
        {
          id: "c-cold-reason",
          author: "agent",
          text: COLD_REASON,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    // Unflagged task with one plain comment: the computed-style baseline
    // the cold-load tint asserts against (no inline-style comparison).
    const plain = createTask(tempDir, {
      title: "Unflagged task",
      description: "plain baseline by kanban-attention-icon.test.ts",
      selector: "/",
      type: "Task",
      status: "todo",
    });
    plainTaskId = plain.id;
    writeTaskJson(tempDir, {
      ...plain,
      comments: [
        {
          id: "c-plain-note",
          author: "Owner",
          text: PLAIN_NOTE,
          createdAt: new Date().toISOString(),
        },
      ],
    });

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

  it("detail header bell pulses with the shared breathe animation", async () => {
    const panelOpen = page.waitForSelector("#detail-panel.open", {
      timeout: 8_000,
    });
    await page.click(
      `article.task-card[data-task-id="${rootTaskId}"] span[data-role="card-title"]`,
    );
    await panelOpen;
    const sel = `#dp-attention-row [data-attention-state="flagged"]`;
    await page.waitForSelector(sel, { state: "visible", timeout: 8_000 });
    // The header bell rides the same CSS-only pulse as the card bell —
    // real browser computes the keyframes (unit pins the stylesheet).
    const animationName = await page.$eval(
      sel,
      (el) => getComputedStyle(el).animationName,
    );
    expect(animationName).toContain("attention-breathe");
    await page.click("#dp-close");
  });

  it("external set-attention tints the flag row and shows the reason live", async () => {
    // Owner gap (round 2): on the LOCAL board a `tasks --edit
    // --set-attention --comment` file write must surface BOTH the tinted
    // attention change row AND the reason comment in the open detail
    // activity feed — the flag row arrives via the task-changed diff, the
    // reason via the comment refetch the frame triggers. Seeded unflagged,
    // flagged mid-test through a direct file write (same bytes the CLI
    // writes), so this pins the live watcher path, not a seeded fixture.
    const live = createTask(tempDir, {
      title: "Live-flagged task",
      description: "flagged mid-test by kanban-attention-icon.test.ts",
      selector: "/",
      type: "Task",
      status: "todo",
    });
    const cardSel = `article.task-card[data-task-id="${live.id}"]`;
    await page.waitForSelector(cardSel, { timeout: 15_000 });
    const panelOpen = page.waitForSelector("#detail-panel.open", {
      timeout: 8_000,
    });
    await page.click(`${cardSel} span[data-role="card-title"]`);
    await panelOpen;
    await page.click("#dp-tab-activity");
    await page.waitForSelector("#dp-tab-activity.active", {
      timeout: 8_000,
    });
    const reason =
      "Blocked: awaiting design tokens for the empty state. Need: token names.";
    writeTaskJson(tempDir, {
      ...live,
      needsAttention: true,
      comments: [
        {
          id: "c-live-reason",
          author: "agent",
          text: reason,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    // The card bell appears live off the same watcher frame.
    await page.waitForSelector(
      `${cardSel} [data-attention-state="flagged"]`,
      { state: "visible", timeout: 15_000 },
    );
    // The flag row reaches the feed with field metadata intact — tinted
    // amber, not a plain change row.
    const rowSel = `#detail-panel [data-activity="attention-change"]`;
    await page.waitForSelector(rowSel, {
      state: "visible",
      timeout: 15_000,
    });
    const rowStyle = await page.$eval(
      rowSel,
      (el) => el.getAttribute("style") ?? "",
    );
    expect(rowStyle).toContain("color-mix");
    expect(rowStyle).toContain("t-warning");
    const rowText = await page.$eval(rowSel, (el) => el.textContent ?? "");
    expect(rowText).toContain("attention");
    // The reason comment lands in the same feed without a reload.
    await page
      .locator("#detail-panel")
      .getByText(reason, { exact: false })
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.click("#dp-close");
  });

  it("cold load derives the attention row and tints the reason comment", async () => {
    // Owner-eyeballed gap: the pre-flagged task was flagged BEFORE the
    // board opened, so no live diff-event ever fires for it. Cold-load
    // must still show the amber attention row AND the reason comment
    // amber-tinted — both derived from current task state at render.
    // The card bell jumps straight to the activities tab.
    const cardSel = `article.task-card[data-task-id="${preFlaggedTaskId}"]`;
    await page.waitForSelector(cardSel, { timeout: 15_000 });
    const panelOpen = page.waitForSelector("#detail-panel.open", {
      timeout: 8_000,
    });
    await page.click(`${cardSel} button[data-attention-press="true"]`);
    await panelOpen;
    await page.waitForSelector("#dp-tab-activity.active", {
      timeout: 8_000,
    });
    // The state-derived row: amber wash + hairline, naming the field.
    const rowSel = `#detail-panel [data-activity="attention-change"]`;
    await page.waitForSelector(rowSel, {
      state: "visible",
      timeout: 15_000,
    });
    const rowStyle = await page.$eval(
      rowSel,
      (el) => el.getAttribute("style") ?? "",
    );
    expect(rowStyle).toContain("color-mix");
    expect(rowStyle).toContain("t-warning");
    const rowText = await page.$eval(rowSel, (el) => el.textContent ?? "");
    expect(rowText).toContain("attention");
    // Exactly one attention row — cold load derives, never duplicates.
    expect(
      await page.locator(`#detail-panel [data-activity="attention-change"]`).count(),
    ).toBe(1);
    // The reason comment carries the tint hook and its text.
    const reasonSel = `#detail-panel [data-attention="reason"]`;
    await page.waitForSelector(reasonSel, {
      state: "visible",
      timeout: 15_000,
    });
    await page
      .locator("#detail-panel")
      .getByText(COLD_REASON, { exact: false })
      .waitFor({ state: "visible", timeout: 15_000 });
    // Computed-style proof (no screenshot artifact): the reason card
    // resolves to a different background than a plain comment card on the
    // unflagged baseline task — the tint is real paint, not just markup.
    const cardOf = (wrapperSel: string) =>
      `${wrapperSel} div[style*="t-warning"], ${wrapperSel} div[style*="--t-input"]`;
    const reasonBg = await page.$eval(
      cardOf(reasonSel),
      (el) => getComputedStyle(el).backgroundColor,
    );
    await page.click("#dp-close");
    const plainCardSel = `article.task-card[data-task-id="${plainTaskId}"]`;
    await page.click(`${plainCardSel} span[data-role="card-title"]`);
    await page.waitForSelector("#detail-panel.open", { timeout: 8_000 });
    await page.click("#dp-tab-activity");
    const plainSel = `#detail-panel [data-comment-id="c-plain-note"]`;
    await page.waitForSelector(plainSel, {
      state: "visible",
      timeout: 15_000,
    });
    const plainBg = await page.$eval(
      cardOf(plainSel),
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(reasonBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(plainBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(reasonBg).not.toBe(plainBg);
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
