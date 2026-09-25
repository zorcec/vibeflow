/**
 * Regression guard for the verify-badge persistence report (reported three
 * times by the owner): open a task card whose `verified: true` badge is
 * rendered and assert the badge SURVIVES the interaction.
 *
 * The most valuable part is the STALENESS GUARD. The kanban client bundle is
 * inlined into the served HTML at PROCESS START (tsup writes
 * src/server/kanban-bundle.gen.ts, the compiled server embeds it, and every
 * board started afterwards serves that frozen copy forever). A board started
 * before a rebuild therefore serves pre-fix JS forever — which has now cost
 * three sessions of "the bug is still there" while the fix was actually in the
 * served code. This test fails loudly, naming the trap, when:
 *   1. dist/client/kanban-browser.js is older than the newest kanban source
 *      file (stale dist — run the build), or
 *   2. the served inline bundle differs from the built bundle on disk, or
 *   3. the served bundle lacks the current-fix marker (`mergeTaskFromPayload`).
 *
 * Network instrumentation records every HTTP response and WebSocket frame
 * carrying the seeded task and fails, naming the endpoint/frame, if any payload
 * for that task omits the `verified` key — a field-dropping path reports its
 * culprit URL, not just a red badge.
 *
 * Hermetic: seeds its own scratch project under /tmp (root task in review with
 * verified: true plus a child so panel relations render), serves it on its own
 * port, and kills the server afterwards. Never touches ports 3700/3793.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import { createTask, writeTaskJson } from "../../src/core/tasks.js";

const PORT = 3961;
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

const FIX_MARKER = "mergeTaskFromPayload";

/** Newest mtime (ms) across non-test *.ts/*.tsx/*.css under a tree.
 * Test files are excluded: they never reach the served bundle and would
 * false-positive the freshness guard on every test edit. */
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

interface PayloadCulprit {
  origin: string;
  keys: string[];
}

describe("verify badge persists through card open (staleness-guarded)", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let tempDir: string;
  let instance: ServeInstance;
  let rootTaskId: string;
  const httpCulprits: PayloadCulprit[] = [];
  const wsCulprits: PayloadCulprit[] = [];

  beforeAll(async () => {
    // ── Staleness guard 1: dist must not be older than the newest source ──
    const distBundle = "dist/client/kanban-browser.js";
    const distMtime = statSync(distBundle).mtimeMs;
    const srcNewest = Math.max(
      newestSourceMtime(join("src", "client", "kanban")),
      newestSourceMtime(join("..", "ui", "src", "kanban")),
    );
    expect(distMtime, STALE_DIST_MSG).toBeGreaterThanOrEqual(srcNewest);

    // ── Seed a hermetic scratch project ──
    tempDir = mkdtempSync(join(tmpdir(), "verify-badge-pw-"));
    // Root task in review with a verified verdict, plus a child so panel
    // relations render when the card is opened.
    const root = createTask(tempDir, {
      title: "Verified root task",
      description: "seeded by kanban-verify-badge-persistence.test.ts",
      selector: "/",
      type: "Task",
      status: "review",
    });
    const child = createTask(tempDir, {
      title: "Child of verified root",
      description: "child for panel relations",
      selector: "/",
      type: "Task",
      status: "todo",
      links: [{ taskId: root.id, type: "parent" }],
    });
    void child;
    rootTaskId = root.id;
    writeTaskJson(tempDir, { ...root, verified: true });

    // ── Start the board on its own scratch port ──
    instance = await serve(undefined, {
      port: PORT,
      open: false,
      projectDir: tempDir,
    });

    // ── Staleness guard 2+3: served bundle must BE the built bundle ──
    const html = await (await fetch(`${BASE}/kanban`)).text();
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1],
    );
    const servedBundle = inlineScripts.find((s) => s.length > 10_000);
    expect(servedBundle, STALE_SERVED_MSG).toBeDefined();
    const diskBundle = readFileSync(distBundle, "utf-8");
    expect(servedBundle, STALE_SERVED_MSG).toBe(diskBundle);
    expect(servedBundle, STALE_SERVED_MSG).toContain(FIX_MARKER);

    // ── Browser + network instrumentation ──
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
    });
    page = await context.newPage();

    // A payload carrying the seeded task MUST include `verified: true` — it is
    // on disk. Any task payload omitting the key names its origin here.
    const inspectTask = (task: unknown, origin: string) => {
      if (!task || typeof task !== "object") return;
      const t = task as Record<string, unknown>;
      if (t.id !== rootTaskId) return;
      if (!("verified" in t)) {
        httpCulprits.push({ origin, keys: Object.keys(t) });
      }
    };
    page.on("response", (res) => {
      const url = res.url();
      if (!url.includes("/api/tasks")) return;
      const ct = res.headers()["content-type"] ?? "";
      if (!ct.includes("json")) return;
      void res
        .json()
        .then(
          (body: unknown) => {
            const b = body as {
              task?: unknown;
              tasks?: unknown[];
            };
            if (b?.task) {
              inspectTask(
                b.task,
                `HTTP ${res.request().method()} ${url} → .task`,
              );
            }
            if (Array.isArray(b?.tasks)) {
              for (const t of b.tasks) inspectTask(t, `HTTP GET ${url} → .tasks[]`);
            }
          },
          () => {
            /* non-JSON/empty body — nothing to inspect */
          },
        );
    });
    page.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        try {
          const msg = JSON.parse(String(frame.payload)) as {
            type?: string;
            task?: unknown;
          };
          if (msg?.task) {
            inspectTask(
              msg.task,
              `WS frame type=${msg.type ?? "unknown"}`,
            );
          }
        } catch {
          /* ignore malformed frames */
        }
      });
    });

    await page.goto(`${BASE}/kanban`);
    await page.waitForSelector("#kanban-board");
  });

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    await instance?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("renders the verified badge before any interaction", async () => {
    const badgeSel = `[data-task-id="${rootTaskId}"] [data-verify-state="verified"]`;
    await page.waitForSelector(badgeSel, { state: "visible", timeout: 8_000 });
    const label = await page.getAttribute(badgeSel, "aria-label");
    expect(label).toBe("Verified — implemented correctly");
  });

  it("keeps the verified badge after clicking the card, 5s idle, and closing the panel", async () => {
    const badgeSel = `[data-task-id="${rootTaskId}"] [data-verify-state="verified"]`;
    const panelOpen = page.waitForSelector("#detail-panel.open", {
      timeout: 8_000,
    });
    // Real user action: a real click on the card title (opens the panel and
    // fires POST /api/tasks/:id/opened + the task-changed WS frame).
    await page.click(
      `article.task-card[data-task-id="${rootTaskId}"] span[data-role="card-title"]`,
    );
    await panelOpen;

    // Badge must survive the open + read-state round-trip.
    await page.waitForSelector(badgeSel, { state: "visible", timeout: 8_000 });

    // Badge must survive past the 5s polling-fallback window too.
    await page.waitForTimeout(5_200);
    await page.waitForSelector(badgeSel, { state: "visible", timeout: 3_000 });
    const labelAfterIdle = await page.getAttribute(badgeSel, "aria-label");
    expect(labelAfterIdle).toBe("Verified — implemented correctly");

    // Badge must survive closing the panel.
    await page.click("#dp-close");
    await page.waitForSelector(badgeSel, { state: "visible", timeout: 5_000 });

    // The instrumentation is the actual point: name any endpoint or WS frame
    // that dropped `verified` for the seeded task.
    const report = (label: string, culprits: PayloadCulprit[]) =>
      culprits
        .map(
          (c) => `${label} culprit: ${c.origin} — payload keys: ${c.keys.join(", ")}`,
        )
        .join("\n");
    const culpritsReport = [
      report("HTTP", httpCulprits),
      report("WebSocket", wsCulprits),
    ]
      .filter(Boolean)
      .join("\n");
    expect(
      httpCulprits.length + wsCulprits.length,
      culpritsReport ||
        "some HTTP endpoint or WS frame dropped the verified field",
    ).toBe(0);
  });
});
