/**
 * verify page-wide — real chromium, real annotated task, real evidence.
 *
 * This replaces `tests/e2e/verify-page-wide.test.ts`, which was `describe.skip`'d
 * and had never run a single assertion. It could not even load (CJS `__dirname`
 * under ESM), and its `beforeAll` execSync'd the never-exiting `kanban` server
 * on a hardcoded port, then `lsof`-killed it in `afterAll`. That file is
 * DELETED, not left skipped: a skipped spec sitting inside a run that reports
 * green is exactly what let this coverage disappear unnoticed.
 *
 * Four defects in the old spec, all fixed here:
 *  1. `TASK_ID = "e2e-page-wide-test"` was never an id `tasks --add` generates,
 *     so `verify` answered E_NOT_FOUND. The id is now read out of the create
 *     result and used for every later call.
 *  2. The task was created with no `--url` and no selector, so verify refused
 *     E_NO_URL before ever launching a browser, and there was no baseline
 *     (E_NO_BASELINE). The task is annotated here the way the overlay does it —
 *     url + selector, plus a REAL baseline captured in a browser and POSTed to
 *     the server's own `/baseline` + `/baseline-page` endpoints.
 *  3. `run()` returned raw stdout and `JSON.parse`d it, but `verify` prints the
 *     human banner (`printResult`) before the JSON, so it could never parse.
 *     Every CLI call here passes `--json`, and the spec asserts on stdout
 *     parsing as JSON in its own right.
 *  4. The CJS/`__dirname` + `lsof` teardown. Gone: an in-process `serve()` on
 *     an ephemeral port, closed in `afterAll`, with the bounded retry that
 *     `getFreePort()`'s probe-then-bind TOCTOU window requires under a 4–8 fork
 *     pool.
 *
 * Why the assertions cannot pass without a real browser: `verify` only writes
 * `verify-all-styles.json` and `verify-page-diff.json` after it has launched
 * chromium, navigated to the annotated url and run `capturePageWideElements`
 * through `page.evaluate`. Both files are asserted on here, along with the
 * back-filled page baselines and what the page-wide query tools make of them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium } from "playwright";
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
import { capturePageWideElements, MAX_ELEMENTS } from "../../src/commands/verify.js";
import type { DomSnapshot } from "../../src/core/verification-types.js";
import { getFreePort } from "../ports.js";

process.env.VIBEFLOW_TELEMETRY = "0";

/** The CLI under test — the shipped dist bundle, unless a coverage run points elsewhere. */
const CLI =
  process.env.VIBEFLOW_E2E_CLI ?? join(process.cwd(), "dist", "index.js");

/** The card title at baseline-capture time. */
const BEFORE_TITLE = "Card title as captured in the baseline";
/**
 * The card title AFTER the baseline was captured. Changed on purpose: the
 * page-wide tools can only prove they diff real snapshots if something
 * actually differs between the two captures.
 */
const AFTER_TITLE = "Card title rewritten after the baseline was captured";

/** A path the board does not serve — used to prove the absolute url is used verbatim. */
const BOGUS_PATH = "/this-path-does-not-exist-on-the-board";

/**
 * Where Playwright's browsers actually are. The CLI child below runs with an
 * isolated HOME (so a real `~/.vibeflow/token` on the machine cannot flip
 * `tasks` into SaaS mode) — but Playwright resolves its browser download under
 * HOME too, so without this the child answers E_PLAYWRIGHT_MISSING.
 */
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
let taskId: string;
let selector: string;

/** Files verify must leave in the task's evidence dir after a full run. */
const EVIDENCE_FILES = [
  "verify-after.json",
  "verify-diff.json",
  "verify-console.txt",
  "verify-page.html",
  "verify-all-styles.json",
  "verify-screenshot.webp",
  "verify-element.html",
  "verify-page-diff.json",
  "baseline.json",
];

/**
 * Run the CLI against the scratch project with an isolated HOME, so a real
 * `~/.vibeflow/token` on the machine cannot silently flip `tasks` into SaaS
 * mode. Async on purpose: the board this spec started lives in THIS event loop,
 * and the verify run needs it to answer chromium's page load.
 */
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
          ...process.env,
          HOME: home,
          VIBEFLOW_TELEMETRY: "0",
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

/** Run a CLI command that must succeed and answer with JSON on stdout. */
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

function readEvidenceJson(id: string, name: string): any {
  const path = join(filesDir(id), name);
  expect(existsSync(path), `missing evidence file: ${name}`).toBe(true);
  return JSON.parse(readFileSync(path, "utf-8"));
}

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "verify-page-wide-pw-"));
  home = mkdtempSync(join(tmpdir(), "verify-page-wide-home-"));

  // ── Boot the board on an ephemeral port ────────────────────────────────
  // getFreePort() probes and releases; under a 4–8 fork pool another file can
  // claim the port before the bind. Bounded retry, so a genuine failure still
  // surfaces instead of hanging.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      port = await getFreePort();
      // @internal test hooks — force OFFLINE mode deterministically; without
      // them the server reads the real ~/.vibeflow/token and hides every local
      // task API behind a 503.
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
  if (!instance) throw lastErr;
  base = `http://localhost:${port}`;

  // `verify` resolves a relative task.url as
  // http://localhost:${readConfig(projectDir).port ?? 3700}${url}
  // (src/commands/verify.ts) — so the scratch project must carry the port the
  // board is actually on, and the relative url branch gets exercised.
  writeConfig(tempDir, { port });

  // ── Create the task through the CLI and keep the id it really made ────
  ensureTaskDirs(tempDir);
  const created = await runCliJson([
    "tasks",
    "--add",
    "--json",
    "--title",
    BEFORE_TITLE,
    "--description",
    "task for the verify page-wide harness",
  ]);
  expect(created.ok).toBe(true);
  taskId = created.task.id as string;
  expect(taskId, "the create result must carry the real generated id").toBeTruthy();

  // The overlay records the annotated element's url + css selector at create
  // time; `tasks --add` has no flags for either, so they are set the same way
  // the overlay's payload sets them.
  selector = `article.task-card[data-task-id="${taskId}"]`;
  updateTask(tempDir, taskId, {
    url: "/kanban",
    selector,
    cssSelector: selector,
  });

  // ── Capture a REAL baseline in a real browser ─────────────────────────
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();
  await page.goto(`${base}/kanban`);
  await page.waitForSelector(selector, { state: "visible", timeout: 15_000 });

  // Element snapshot. Written inline rather than reusing the overlay's
  // `captureDomSnapshot` because Playwright serializes the function SOURCE:
  // that one closes over the module-scoped RELEVANT_STYLES import and would
  // throw at the page boundary. Mirrors it, with the property list passed as
  // plain data — the same fix `capturePageWideElements` documents.
  const elementBaseline = (await page.evaluate(
    ({ sel, styles }: { sel: string; styles: string[] }): DomSnapshot => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`annotation target not found: ${sel}`);
      const computed = window.getComputedStyle(el);
      const computedStyles: Record<string, string> = {};
      for (const prop of styles) {
        computedStyles[prop] = computed.getPropertyValue(prop);
      }
      const parts: string[] = [];
      for (
        let cur: Element | null = el;
        cur && cur !== document.documentElement;
        cur = cur.parentElement
      ) {
        let index = 1;
        let sib: Element | null = cur.previousElementSibling;
        while (sib) {
          if (sib.tagName === cur.tagName) index++;
          sib = sib.previousElementSibling;
        }
        parts.unshift(`${cur.tagName.toLowerCase()}[${index}]`);
      }
      const rect = el.getBoundingClientRect();
      const parent = el.parentElement;
      return {
        outerHTML: el.outerHTML,
        computedStyles,
        selector: sel,
        xpath: "/" + parts.join("/"),
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
            dpr: window.deviceRatio,
          },
          stackingContext: {
            zIndex: computed.zIndex,
            position: computed.position,
          },
        },
        parentSnippet:
          parent && parent !== document.body
            ? parent.outerHTML.slice(0, 500)
            : undefined,
        browser: navigator.userAgent,
        consoleErrors: [],
        capturedAt: new Date().toISOString(),
      };
    },
    { sel: selector, styles: RELEVANT_STYLES },
  )) as DomSnapshot;

  // Page-wide snapshot: the exact callback verify itself runs, so the two
  // captures are produced by the same code and are directly comparable.
  const pageBaseline = await page.evaluate(capturePageWideElements, {
    styles: RELEVANT_STYLES,
    maxElements: MAX_ELEMENTS,
  });

  const post = async (endpoint: string, body: unknown) => {
    const res = await fetch(`${base}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status, `POST ${endpoint} → ${res.status}`).toBe(200);
  };
  await post(`/api/tasks/${taskId}/baseline`, { baseline: elementBaseline });
  await post(`/api/tasks/${taskId}/baseline-page`, { page: pageBaseline });

  // ── Change the page after the baseline ────────────────────────────────
  // The page-wide query tools compare the two captures, so they can only prove
  // they work if the captures differ.
  const patched = await fetch(`${base}/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: AFTER_TITLE }),
  });
  expect(patched.status, `PATCH task title → ${patched.status}`).toBe(200);
}, 120_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await instance?.close();
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("verify page-wide (real browser, real evidence)", () => {
  it(
    "writes the full evidence set and back-fills the page-wide baselines",
    async () => {
      const result = await runCliJson(["verify", taskId, "--json"]);

      // `--json` is what makes stdout parseable at all: the human path
      // prints the `printResult` banner first.
      expect(result.taskId).toBe(taskId);
      expect(result.ok).toBe(true);
      expect(result.diff.selectorResolves).toBe(true);
      expect(result.captureTruncated).toBe(false);
      // The title changed after the baseline, so the element diff must see it.
      expect(result.diff.htmlChanged).toBe(true);
      expect(result.verdict).toContain("HTML changed");

      // Every evidence file verify promises, on disk and non-empty.
      for (const name of EVIDENCE_FILES) {
        const path = join(filesDir(taskId), name);
        expect(existsSync(path), `missing evidence file: ${name}`).toBe(true);
        expect(statSync(path).size, `empty evidence file: ${name}`).toBeGreaterThan(0);
      }
      const reported = (result.evidenceFiles as string[]).map(
        (f) => f.split("/").pop() as string,
      );
      for (const name of EVIDENCE_FILES) {
        expect(reported, `${name} missing from result.evidenceFiles`).toContain(
          name,
        );
      }

      // The page-wide snapshot itself.
      const allStyles = readEvidenceJson(taskId, "verify-all-styles.json");
      expect(allStyles.version).toBe(1);
      expect(allStyles.truncated).toBe(false);
      const elements = Object.values(allStyles.elements) as any[];
      expect(elements.length).toBeGreaterThan(0);

      const card = elements.find((e) => e.dataAttrs?.["task-id"] === taskId);
      expect(card, "the annotated card must be in the page-wide snapshot").toBeDefined();
      expect(card.selector).toContain("task-card");
      expect(card.tag).toBe("article");
      expect(card.text).toContain(AFTER_TITLE);
      // `baseline` is back-filled from baseline-page.json (verify.ts step 14) —
      // the same file the page-wide query tools diff against.
      expect(Object.keys(card.baseline)).toHaveLength(RELEVANT_STYLES.length);

      // The page baseline predates the after-snapshot: these are two captures,
      // not one file read twice.
      const pageBaseline = readEvidenceJson(taskId, "baseline-page.json");
      expect(Object.keys(pageBaseline.elements).length).toBeGreaterThan(0);
      expect(
        Date.parse(allStyles.capturedAt),
      ).toBeGreaterThanOrEqual(Date.parse(pageBaseline.capturedAt));

      // The page diff is only written when a page baseline exists, so its
      // presence IS the proof the back-fill branch ran.
      const pageDiff = readEvidenceJson(taskId, "verify-page-diff.json");
      expect(typeof pageDiff.totalChanged).toBe("number");
      expect(pageDiff.truncated).toBe(false);
      expect(typeof pageDiff.elements).toBe("object");

      // A real transformed screenshot, not an empty placeholder: WebP
      // container magic (RIFF....WEBP) — capture applies the image matrix,
      // so the raw PNG is never written.
      const shot = readFileSync(
        join(filesDir(taskId), "verify-screenshot.webp"),
      );
      expect([...shot.subarray(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46]);
      expect(shot.subarray(8, 12).toString("ascii")).toBe("WEBP");

      // The element snapshot round-tripped the real outerHTML of the card.
      const after = readEvidenceJson(taskId, "verify-after.json");
      expect(after.outerHTML).toContain(`data-task-id="${taskId}"`);
      expect(after.computedStyles).toHaveProperty("display");
      expect(after.position.viewport.width).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    "resolves an absolute task.url without prepending the config port",
    async () => {
      // The other half of verify's URL resolution: `rawUrl.startsWith("http")`
      // must be used verbatim. The last test in this file moves the url to a
      // path the board does not serve; that is where the branch is proven.
      updateTask(tempDir, taskId, { url: `${base}/kanban` });
      const result = await runCliJson(["verify", taskId, "--json"]);
      expect(result.ok).toBe(true);
      expect(result.diff.selectorResolves).toBe(true);
      expect(existsSync(join(filesDir(taskId), "verify-all-styles.json"))).toBe(true);
    },
    120_000,
  );

  it(
    "html_query text reports the change made after the baseline",
    async () => {
      const parsed = await runCliJson([
        "verify",
        "html_query",
        taskId,
        "text",
        "--json",
      ]);
      expect(parsed.ok).toBe(true);
      expect(parsed.tool).toBe("html_query");
      expect(parsed.queryType).toBe("text");
      expect(parsed.truncated).toBe(false);
      expect(Array.isArray(parsed.matches)).toBe(true);
      // Non-vacuous: the title really was rewritten between the two captures.
      expect(parsed.matches.length).toBeGreaterThan(0);
      expect(
        parsed.matches.some((m: { details: string }) =>
          m.details.includes(AFTER_TITLE),
        ),
        `no text change mentioning "${AFTER_TITLE}" in:\n${JSON.stringify(parsed.matches, null, 2)}`,
      ).toBe(true);
    },
    60_000,
  );

  it(
    "html_query children and attributes answer over the page-wide snapshot",
    async () => {
      const children = await runCliJson([
        "verify",
        "html_query",
        taskId,
        "children",
        "--json",
      ]);
      expect(children.ok).toBe(true);
      expect(children.queryType).toBe("children");
      expect(Array.isArray(children.matches)).toBe(true);

      const attrs = await runCliJson([
        "verify",
        "html_query",
        taskId,
        "attributes",
        "--json",
      ]);
      expect(attrs.ok).toBe(true);
      expect(attrs.queryType).toBe("attributes");
      expect(Array.isArray(attrs.matches)).toBe(true);
    },
    60_000,
  );

  it(
    "style_query, style_diff and element_info read the captured evidence",
    async () => {
      const query = await runCliJson([
        "verify",
        "style_query",
        taskId,
        "color",
        "--json",
      ]);
      expect(query.ok).toBe(true);
      expect(query.tool).toBe("style_query");
      expect(query.property).toBe("color");
      expect(query.truncated).toBe(false);
      expect(Array.isArray(query.matches)).toBe(true);

      // `style_diff` is the SINGLE-element tool: it summarises
      // verify-diff.json (stylesChanged), so it reports `total`/`matched` and
      // the changed `styles` map — there is no `elementCount` on this surface.
      const diff = await runCliJson([
        "verify",
        "style_diff",
        taskId,
        "--json",
      ]);
      expect(diff.ok).toBe(true);
      expect(diff.tool).toBe("style_diff");
      expect(typeof diff.total).toBe("number");
      expect(typeof diff.matched).toBe("number");
      expect(typeof diff.styles).toBe("object");

      const info = await runCliJson([
        "verify",
        "element_info",
        taskId,
        "--json",
      ]);
      expect(info.ok).toBe(true);
      expect(info.selector).toBe(selector);
      expect(info.position.viewport.width).toBeGreaterThan(0);
      expect(Array.isArray(info.consoleErrors)).toBe(true);
    },
    60_000,
  );

  it(
    "uses an absolute url verbatim — a path the board does not serve cannot resolve the selector",
    async () => {
      updateTask(tempDir, taskId, { url: `${base}${BOGUS_PATH}` });
      const res = await runCli(["verify", taskId, "--json"]);
      expect(res.code).toBe(0);
      const result = JSON.parse(res.stdout);
      // The relative branch would have resolved `http://localhost:${port}/kanban`
      // and found the card. Resolving nothing here proves the absolute url was
      // navigated to as given.
      expect(result.diff.selectorResolves).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.verdict).toContain("no longer resolves");
    },
    120_000,
  );
});
