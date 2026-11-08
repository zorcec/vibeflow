/**
 * verify --pixels — pixel-proof evidence (ticket 080966d13869639d).
 *
 * Real chromium, real annotated task, real evidence. The flow under test:
 *   1. first `--pixels` run BOOTSTRAPS the baseline (`verify-baseline-pixels.png`
 *      === `verify-after-pixels.png`, delta 0/0) — a single run has no past
 *      to compare with, so it stores the present instead of inventing a diff;
 *   2. a second run with nothing changed reports a SMALL delta (<= 15 — the
 *      old bell-glow amplitude that the owner could not see for three rounds);
 *   3. after a VISIBLE change (same-length title rewrite, so the card box —
 *      and therefore the capture size — is unchanged) the run reports a LARGE
 *      delta (>= 40);
 *   4. `--min-pixel-delta 40` fails `ok` on the unchanged board (demand NOT
 *      met) and passes it after the visible change; the default 0 never fails.
 *
 * Why these assertions cannot pass without a real browser: the pixel files
 * are element-region screenshots (`element.screenshot()`) taken inside the
 * verify run's own chromium, decoded with the repo's `decodePng` and diffed
 * per channel. A stubbed capture cannot produce the small-then-large shape.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium } from "playwright";
import { guardContext, type ErrorGuard } from "./error-guard";
import type { Browser, BrowserContext, Page } from "playwright";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { serve } from "../../src/server/server.js";
import type { ServeInstance } from "../../src/server/server.js";
import { ensureTaskDirs, updateTask } from "../../src/core/tasks.js";
import { writeConfig } from "../../src/core/config.js";
import { RELEVANT_STYLES } from "../../src/core/page-selector.js";
import type { DomSnapshot } from "../../src/core/verification-types.js";
import { getFreePort } from "../ports.js";
// Module-anchored CLI entry (ticket 8ac96ef9) — never process.cwd().
import { CLI_ENTRY as CLI, isolatedCliEnv } from "../e2e/spawn-isolated.js";

process.env.VIBEFLOW_TELEMETRY = "0";

/** Same length (22 chars), different glyphs: the card box is unchanged, so
 * the captures stay comparable (sameSize true) while the paint differs. */
const BEFORE_TITLE = "Pixel probe card alpha";
const AFTER_TITLE = "Pixel probe card omega";

const BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  join(homedir(), ".cache", "ms-playwright");

let tempDir: string;
let home: string;
let port: number;
let base: string;
let instance: ServeInstance;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let guard: ErrorGuard;
let taskId: string;
let selector: string;

function runCli(
  args: string[],
  timeoutMs = 90_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [CLI, ...args],
      {
        cwd: tempDir,
        encoding: "utf-8",
        timeout: timeoutMs,
        env: {
          ...isolatedCliEnv({ home, cwd: tempDir }),
          PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH,
        },
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? (err as NodeJS.ErrnoException).code
            : err
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

async function runCliJson(args: string[]): Promise<any> {
  const res = await runCli(args);
  expect(
    res.stderr,
    `\`${args.join(" ")}\` wrote to stderr: ${res.stderr}`,
  ).toBe("");
  expect(res.code, `\`${args.join(" ")}\` exit ${res.code}`).toBe(0);
  let parsed: unknown;
  expect(
    () => {
      parsed = JSON.parse(res.stdout);
    },
    `\`${args.join(" ")}\` stdout is not JSON (pass --json!):\n${res.stdout}`,
  ).not.toThrow();
  return parsed;
}

function filesDir(id: string): string {
  return join(tempDir, ".vibeflow", "tasks", "files", id);
}

function pngBytes(id: string, name: string): Buffer {
  const path = join(filesDir(id), name);
  expect(existsSync(path), `missing evidence file: ${name}`).toBe(true);
  const bytes = readFileSync(path);
  expect(statSync(path).size, `empty evidence file: ${name}`).toBeGreaterThan(0);
  // PNG magic, not WebP: pixel evidence keeps its true .png extension and is
  // decoded with decodePng (no transcode — the captures must stay comparable).
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
}

beforeAll(async () => {
  expect(BEFORE_TITLE.length).toBe(AFTER_TITLE.length);
  tempDir = mkdtempSync(join(tmpdir(), "verify-pixels-pw-"));
  home = mkdtempSync(join(tmpdir(), "verify-pixels-home-"));

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      port = await getFreePort();
      instance = await serve(undefined, {
        port,
        open: false,
        projectDir: tempDir,
        _testToken: null,
        _testWorkspace: null,
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!instance!) throw lastErr;
  base = `http://localhost:${port}`;
  writeConfig(tempDir, { port });

  ensureTaskDirs(tempDir);
  const created = await runCliJson([
    "tasks",
    "--add",
    "--json",
    "--title",
    BEFORE_TITLE,
    "--description",
    "task for the verify --pixels harness",
  ]);
  expect(created.ok).toBe(true);
  taskId = created.task.id as string;
  expect(taskId, "the create result must carry the real generated id").toBeTruthy();

  // The ANNOTATED region is the card TITLE span, not the whole card —
  // deliberately. Every verify run appends a system comment, and the card
  // renders comment/file/children chrome (footer icon, compact indicators)
  // from it, so a whole-card capture changes box the run after the
  // bootstrap. The title span's box and paint are immune to that chrome
  // (flex:1 row fill, text only) while still showing the title rewrite —
  // the same reason the real bell task annotates the bell, not the page.
  selector = `article.task-card[data-task-id="${taskId}"] [data-role="card-title"]`;
  updateTask(tempDir, taskId, {
    url: "/kanban",
    selector,
    cssSelector: selector,
  });

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();
  guard = guardContext(context);
  await page.goto(`${base}/kanban`);
  await page.waitForSelector(selector, { state: "visible", timeout: 15_000 });

  // Element baseline the way the overlay captures it (self-contained
  // evaluate callback — see verify-page-wide.test.ts for why it is inline).
  const elementBaseline = (await page.evaluate(
    ({ sel, styles }: { sel: string; styles: string[] }): DomSnapshot => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`annotation target not found: ${sel}`);
      const computed = window.getComputedStyle(el);
      const computedStyles: Record<string, string> = {};
      for (const prop of styles) {
        computedStyles[prop] = computed.getPropertyValue(prop);
      }
      const rect = el.getBoundingClientRect();
      return {
        outerHTML: el.outerHTML,
        computedStyles,
        selector: sel,
        position: {
          boundingBox: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          scrollPosition: { x: window.scrollX, y: window.scrollY },
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            dpr: window.devicePixelRatio,
          },
          stackingContext: {
            zIndex: computed.zIndex,
            position: computed.position,
          },
        },
        browser: navigator.userAgent,
        consoleErrors: [],
        capturedAt: new Date().toISOString(),
      };
    },
    { sel: selector, styles: RELEVANT_STYLES },
  )) as DomSnapshot;

  const res = await fetch(`${base}/api/tasks/${taskId}/baseline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseline: elementBaseline }),
  });
  expect(res.status, `POST baseline → ${res.status}`).toBe(200);
}, 120_000);

afterEach(() => guard.assertNoErrors());

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await instance?.close();
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("verify --pixels (real browser, real evidence)", () => {
  it(
    "bootstraps the pixel baseline on the first --pixels run",
    async () => {
      const result = await runCliJson(["verify", taskId, "--pixels", "--json"]);
      expect(result.taskId).toBe(taskId);
      expect(result.ok).toBe(true);
      // A single run has no past to compare with: delta 0/0, sameSize true.
      expect(result.pixelDelta).toEqual({ max: 0, pct: 0, sameSize: true });
      expect(result.verdict).toContain("baseline captured this run");

      const baseline = pngBytes(taskId, "verify-baseline-pixels.png");
      const after = pngBytes(taskId, "verify-after-pixels.png");
      expect(after.equals(baseline)).toBe(true);

      const reported = (result.evidenceFiles as string[]).map(
        (f) => f.split("/").pop() as string,
      );
      expect(reported).toContain("verify-baseline-pixels.png");
      expect(reported).toContain("verify-after-pixels.png");
    },
    120_000,
  );

  it(
    "reports a small delta when nothing visible changed",
    async () => {
      const result = await runCliJson(["verify", taskId, "--pixels", "--json"]);
      expect(result.ok).toBe(true);
      expect(result.pixelDelta.sameSize).toBe(true);
      // The old bell glow animated a 15/255 channel delta the owner read as
      // "no animation": an unchanged board must stay at or under that.
      expect(result.pixelDelta.max).toBeLessThanOrEqual(15);
      expect(result.verdict).toContain(
        `PIXEL_DELTA=${result.pixelDelta.max}/255`,
      );
    },
    120_000,
  );

  it(
    "fails a --min-pixel-delta demand on the unchanged board",
    async () => {
      // Default threshold 0 never fails on its own (proven by the runs
      // above: ok true). A positive demand fails when nothing visible changed.
      const result = await runCliJson([
        "verify",
        taskId,
        "--pixels",
        "--min-pixel-delta",
        "40",
        "--json",
      ]);
      expect(result.ok).toBe(false);
      expect(result.pixelDelta.sameSize).toBe(true);
      expect(result.pixelDelta.max).toBeLessThanOrEqual(15);
      expect(result.verdict).toContain("NOT met");
    },
    120_000,
  );

  it(
    "prints the PIXEL_DELTA line in human output",
    async () => {
      const res = await runCli(["verify", taskId, "--pixels"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("PIXEL_DELTA=");
    },
    120_000,
  );

  it(
    "reports a large delta after a visible change and satisfies the demand",
    async () => {
      const patched = await fetch(`${base}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: AFTER_TITLE }),
      });
      expect(patched.status, `PATCH task title → ${patched.status}`).toBe(200);

      const result = await runCliJson(["verify", taskId, "--pixels", "--json"]);
      expect(result.pixelDelta.sameSize).toBe(true);
      // Ink on card background moves channels by ~200: far above the <= 15
      // the unchanged board reported.
      expect(result.pixelDelta.max).toBeGreaterThanOrEqual(40);
      expect(result.pixelDelta.pct).toBeGreaterThan(0);
      expect(result.verdict).toContain(
        `PIXEL_DELTA=${result.pixelDelta.max}/255`,
      );

      // The same visible change satisfies the demand that failed before it.
      const demanded = await runCliJson([
        "verify",
        taskId,
        "--pixels",
        "--min-pixel-delta",
        "40",
        "--json",
      ]);
      expect(demanded.ok).toBe(true);
      expect(demanded.pixelDelta.max).toBeGreaterThanOrEqual(40);
    },
    180_000,
  );
});
