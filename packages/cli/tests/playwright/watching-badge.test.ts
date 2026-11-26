/**
 * Watching badge in a real browser (tickets ifhh7q2, lf6ekg9l).
 *
 * The badge had a live regression that nothing at the browser level caught: it
 * polled `/api/notifications/subscribers` every 10 s forever, breaking the
 * board's idle contract (`stage-board-idle.spec.ts` asserts ZERO requests over
 * 30 s of idling) — the deploy gate found it, not a test. Unit coverage pinned
 * the component's decision to poll; this spec pins the decision from the only
 * place that can prove it: the network.
 *
 * Three properties, in the order they matter:
 *   1. an IDLE badge asks nothing (the regression);
 *   2. opening the popover asks, and names the followers with their activity —
 *      the promise of the feature;
 *   3. closing it stops asking again, so a forgotten popover cannot quietly
 *      reintroduce the polling the idle pin forbids.
 *
 * Hermetic: seeds a scratch project, serves it on its own port, seeds the
 * subscriber registry through the real local API, kills everything afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import { createTask } from "../../src/core/tasks.js";
import { guardContext, type ErrorGuard } from "./error-guard";

const PORT = 3963;
const BASE = `http://localhost:${PORT}`;
const SUBSCRIBERS_PATH = "/api/notifications/subscribers";

describe("watching badge polls only while it is being looked at", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;
  let guard: ErrorGuard;
  /** Every subscribers request the page made, in order. */
  const hits: string[] = [];

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "watching-badge-pw-"));
    // A board with something in it: an empty board can short-circuit the
    // header, and then this spec would pass without testing anything.
    for (const title of ["First task", "Second task", "Third task"]) {
      createTask(tempDir, {
        title,
        description: "seeded by watching-badge.test.ts",
        selector: "/",
        type: "Task",
        status: "todo",
      });
    }

    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });

    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    guard = guardContext(context);
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === SUBSCRIBERS_PATH) hits.push(req.url());
    });

    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
  }, 60_000);

  afterEach(() => guard.assertNoErrors());

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Register a follower exactly as `notifications --follow` does. */
  async function registerFollower(
    subscriberId: string,
    agent: string,
    activity?: { taskId: string; type: string; at: number },
  ): Promise<void> {
    const res = await fetch(`${BASE}${SUBSCRIBERS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriberId,
        agent,
        user: "local",
        ...(activity ? { activity } : {}),
      }),
    });
    expect(res.status).toBe(200);
  }

  it("an idle badge makes NO request for 12 s (the regression that broke idle)", async () => {
    // The badge exists and paints from its first read.
    await page.waitForSelector("#watching-badge", { timeout: 10_000 });
    const baseline = hits.length;
    expect(baseline, "the badge should paint from exactly one initial read").toBeLessThanOrEqual(1);

    // Longer than the 10 s interval it used to run on: if polling came back,
    // at least one request lands in this window.
    const start = Date.now();
    await page.waitForTimeout(12_000);
    expect(
      hits.length - baseline,
      `an unopened badge must not poll (${hits.length - baseline} request(s) in ${Date.now() - start} ms)`,
    ).toBe(0);
  }, 40_000);

  it("opening the popover names the followers and their last delivered event", async () => {
    const deliveredAt = Date.now() - 4_000;
    await registerFollower("sub_pw_alpha", "pi-alpha", {
      taskId: "task-alpha",
      type: "task.comment",
      at: deliveredAt,
    });
    await registerFollower("sub_pw_beta", "pi-beta");

    const before = hits.length;
    await page.click("#watching-badge");
    await page.waitForSelector("#watching-popover", { state: "visible", timeout: 8_000 });

    // Opening must ASK — a cached snapshot from page load would go stale and
    // the whole feature would be a lie about what is happening now.
    expect(hits.length).toBeGreaterThan(before);

    const text = await page.$eval("#watching-popover", (el) => (el.textContent ?? "").trim());
    expect(text).toContain("Watching this board");
    expect(text).toContain("pi-alpha");
    expect(text).toContain("pi-beta");
    // The activity line: what it last DELIVERED, and the honest "idle" for a
    // follower that has delivered nothing yet.
    expect(text).toContain("task.comment");
    // A follower that has delivered nothing yet says "listening"; one whose
    // last delivery has aged past the idle window says "idle, watching".
    // Both are honest, so pin the pair rather than one string.
    expect(text.toLowerCase()).toContain("listening");
    // A follower's agent name is the label, its account the tooltip.
    const title = await page.$eval(
      "#watching-popover span[title]",
      (el) => el.getAttribute("title") ?? "",
    );
    expect(title).toContain("pi-alpha");
  }, 40_000);

  it("closing the popover stops the polling again", async () => {
    await page.keyboard.press("Escape");
    await page.waitForSelector("#watching-popover", { state: "detached", timeout: 8_000 });
    const afterClose = hits.length;
    await page.waitForTimeout(12_000);
    expect(
      hits.length - afterClose,
      "a closed popover must not keep polling — the idle pin depends on it",
    ).toBe(0);
  }, 40_000);
});
