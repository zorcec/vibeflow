import chalk from "chalk";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { statSync, readdirSync, unlinkSync } from "node:fs";
import { findTaskFilePath, readTaskFile, updateTask } from "../core/tasks.js";
import { saveFile, getFilesDir, getFilePath } from "../core/files.js";
import { addComment } from "../core/comments.js";
import { decryptAuthState, type EncryptedAuthState } from "../core/auth.js";
import { computeDiff, summarizeDiff } from "../core/diff.js";
import type { DomSnapshot, DiffResult } from "../core/diff.js";
import { ExitCode } from "../core/exit-codes.js";
import { readConfig } from "../core/config.js";
import {
  buildKey,
  buildDisplaySelector,
  filterStyles,
  childSignature,
  normalizeText,
  RELEVANT_STYLES,
} from "../core/page-selector.js";

// Baseline and auth state are now stored in task.json (§6, §7).

// ── Verify result shape (§9.3) ────────────────────────────────────────────
export interface VerifyResult {
  taskId: string;
  ok: boolean;
  taskDescription: string;
  baseline: {
    selector: string;
    url: string;
    capturedAt: string;
    snapshot: DomSnapshot;
  };
  after: {
    snapshot: DomSnapshot;
    consoleErrors: string[];
  };
  diff: DiffResult;
  evidenceFiles: string[];
  verdict: string;
}

// ── Error types (§9.4) ────────────────────────────────────────────────────
export class VerifyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = "VerifyError";
  }
}

// ── Playwright lazy loader ─────────────────────────────────────────────────
async function loadPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch {
    throw new VerifyError(
      "E_PLAYWRIGHT_MISSING",
      "Playwright is not installed.",
      "Run: npx playwright install chromium",
    );
  }
}

// ── Core verification engine (§9.2) ───────────────────────────────────────
export async function verifyTask(
  projectDir: string,
  taskId: string,
  opts: { json?: boolean; url?: string } = {},
): Promise<VerifyResult> {
  const absProjectDir = resolve(projectDir);

  // ── 1. Read task ──────────────────────────────────────────────────────
  const taskFilePath = findTaskFilePath(absProjectDir, taskId);
  if (!taskFilePath) {
    throw new VerifyError(
      "E_NOT_FOUND",
      `Task not found: ${taskId}`,
      "Run 'vibeflow tasks' to see available task IDs.",
    );
  }
  const task = readTaskFile(taskFilePath);
  if (!task) {
    throw new VerifyError("E_NOT_FOUND", `Task not found: ${taskId}`);
  }

  // ── 2. Read baseline snapshot (file-based with legacy fallback) ────────
  let baseline: DomSnapshot | undefined;

  // Try file-based baseline first (new tasks)
  const baselineElementFile =
    task.baselineElementFile || "baseline-element.json";
  const baselinePath = getFilePath(absProjectDir, taskId, baselineElementFile);
  if (baselinePath) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as DomSnapshot;
    } catch {
      // File corrupted, fall through to legacy
    }
  }

  // Fallback: legacy inline baseline in task.json
  if (!baseline && task.baseline) {
    baseline = task.baseline;
  }

  if (!baseline) {
    throw new VerifyError(
      "E_NO_BASELINE",
      "Task has no baseline. Re-annotate to capture one.",
    );
  }

  // ── 3. Read & decrypt auth state from task.json (§7.5) ────────────────
  let cookies: import("../core/auth.js").AuthState["cookies"] = [];
  let localStorageData: Record<string, string> = {};
  let sessionStorageData: Record<string, string> = {};

  if (task.authStateEnc && task.author) {
    try {
      const encrypted: EncryptedAuthState = JSON.parse(task.authStateEnc);
      const authState = decryptAuthState(encrypted, task.author);
      if (!authState) {
        throw new VerifyError(
          "E_AUTH_EXPIRED",
          "Auth state expired. Re-annotate to capture fresh cookies.",
        );
      }
      cookies = authState.cookies;
      localStorageData = authState.localStorage;
      sessionStorageData = authState.sessionStorage;
    } catch (err) {
      if (err instanceof VerifyError) throw err;
      throw new VerifyError(
        "E_AUTH_CORRUPT",
        "Auth state corrupted. Re-annotate.",
      );
    }
  }
  // If no auth state in task.json, proceed without cookies (unauthenticated verification).

  // ── 4. Resolve target URL ─────────────────────────────────────────────
  const rawUrl = opts.url ?? task.url;
  if (!rawUrl) {
    throw new VerifyError(
      "E_NO_URL",
      "Task has no URL. Cannot verify without a target URL.",
      "Re-annotate the element with a URL, or use --url to override.",
    );
  }
  // Prepend origin for relative URLs (e.g. /kanban -> http://localhost:3700/kanban)
  const config = readConfig(absProjectDir);
  const port = config.port ?? 3700;
  const targetUrl = rawUrl.startsWith("http")
    ? rawUrl
    : `http://localhost:${port}${rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl}`;

  // ── 5. Determine selector ─────────────────────────────────────────────
  const selector = task.cssSelector ?? task.selector;
  if (!selector || selector === "/") {
    throw new VerifyError(
      "E_NO_SELECTOR",
      "Task has no CSS selector. Cannot verify without a selector.",
    );
  }

  // ── 6. Launch Playwright ──────────────────────────────────────────────
  const pw = await loadPlaywright();

  let browser: import("playwright").Browser | undefined;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("not found") ||
      msg.includes("not installed") ||
      msg.includes("Executable doesn't exist")
    ) {
      throw new VerifyError(
        "E_PLAYWRIGHT_MISSING",
        "Chromium is not installed.",
        "Run: npx playwright install chromium",
      );
    }
    throw new VerifyError(
      "E_PLAYWRIGHT_CRASH",
      `Verification failed: ${msg}`,
      "Try again.",
    );
  }

  let context: import("playwright").BrowserContext | undefined;
  try {
    // ── 7. Create browser context with baseline viewport ────────────────
    const vp = baseline.position?.viewport;
    context = await browser.newContext({
      viewport: vp ? { width: vp.width, height: vp.height } : undefined,
      deviceScaleFactor: vp?.dpr,
      userAgent: baseline.browser || undefined,
    });

    // ── 8. Inject cookies ───────────────────────────────────────────────
    if (cookies.length > 0) {
      await context.addCookies(
        cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })),
      );
    }

    // ── 9. Inject localStorage / sessionStorage ─────────────────────────
    const page = await context.newPage();

    // Collect console errors.
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });

    // Navigate.
    try {
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("ERR_CONNECTION_REFUSED") ||
        msg.includes("ECONNREFUSED")
      ) {
        throw new VerifyError(
          "E_APP_NOT_RUNNING",
          `Cannot connect to ${targetUrl}. Is the dev server running?`,
        );
      }
      throw new VerifyError(
        "E_NAVIGATION_FAILED",
        `Failed to navigate to ${targetUrl}: ${msg}`,
      );
    }

    // Inject storage after navigation (requires same-origin).
    try {
      if (Object.keys(localStorageData).length > 0) {
        await page.evaluate((data) => {
          for (const [k, v] of Object.entries(data)) {
            window.localStorage.setItem(k, v);
          }
        }, localStorageData);
      }
      if (Object.keys(sessionStorageData).length > 0) {
        await page.evaluate((data) => {
          for (const [k, v] of Object.entries(data)) {
            window.sessionStorage.setItem(k, v);
          }
        }, sessionStorageData);
      }
    } catch {
      // Storage injection may fail on cross-origin — not fatal.
    }

    // ── 10. Wait for selector ───────────────────────────────────────────
    let elementCount = 0;
    try {
      await page.waitForSelector(selector, { timeout: 10_000 });
      elementCount = await page.locator(selector).count();
    } catch {
      // Selector not found — this is a valid signal (element was removed/renamed).
      const afterSnapshot: DomSnapshot = {
        outerHTML: "",
        computedStyles: {},
        selector,
        position: baseline.position,
        browser: baseline.browser,
        consoleErrors,
        capturedAt: new Date().toISOString(),
      };

      const diff = computeDiff(baseline, afterSnapshot);
      return buildResult(
        task.id,
        task.description,
        baseline,
        afterSnapshot,
        diff,
        [],
        selector,
      );
    }

    if (elementCount > 1) {
      // Multiple matches — ambiguous selector.
      const afterSnapshot: DomSnapshot = {
        outerHTML: "",
        computedStyles: {},
        selector,
        position: baseline.position,
        browser: baseline.browser,
        consoleErrors,
        capturedAt: new Date().toISOString(),
      };
      const diff = computeDiff(baseline, afterSnapshot);
      const verdict = `Selector matches ${elementCount} elements. The selector may need to be more specific.`;
      return buildResult(
        task.id,
        task.description,
        baseline,
        afterSnapshot,
        diff,
        [],
        selector,
        verdict,
      );
    }

    // ── 11. Re-capture DOM snapshot ─────────────────────────────────────
    const afterSnapshot = await captureSnapshot(
      page,
      selector,
      baseline,
      consoleErrors,
    );

    // ── 12. Load page baseline and back-fill ─────────────────────────────
    let pageBaseline: {
      elements: Record<string, { after: Record<string, string> }>;
    } | null = null;
    const pageBaselineFile = task.baselineFile || "baseline-page.json";
    const pageBaselinePath = getFilePath(
      absProjectDir,
      taskId,
      pageBaselineFile,
    );
    if (pageBaselinePath) {
      try {
        pageBaseline = JSON.parse(readFileSync(pageBaselinePath, "utf-8"));
      } catch {
        // File corrupted, skip page diff
      }
    }

    // ── 13. Compute structural diff ─────────────────────────────────────
    const diff = computeDiff(baseline, afterSnapshot);

    // ── 13. Store evidence files ────────────────────────────────────────
    const evidenceFiles = await storeEvidence(
      absProjectDir,
      taskId,
      baseline,
      afterSnapshot,
      diff,
      consoleErrors,
      page,
      selector,
    );

    // ── 14. Back-fill page-wide baselines + generate page diff ──────────
    if (pageBaseline && pageBaseline.elements) {
      const allStylesPath = getFilePath(
        absProjectDir,
        taskId,
        "verify-all-styles.json",
      );
      if (allStylesPath) {
        try {
          const afterPage = JSON.parse(readFileSync(allStylesPath, "utf-8"));
          if (afterPage && afterPage.elements) {
            const pageDiff: Record<
              string,
              Record<string, [string, string]>
            > = {};
            const afterEntries = Object.entries(afterPage.elements) as Array<
              [
                string,
                {
                  baseline: Record<string, string>;
                  after: Record<string, string>;
                },
              ]
            >;
            for (const [key, element] of afterEntries) {
              const baselineStyles = (
                pageBaseline!.elements[key] as { after: Record<string, string> }
              )?.after;
              if (baselineStyles) {
                element.baseline = baselineStyles;
                // Compute per-property diff
                const propDiff: Record<string, [string, string]> = {};
                for (const [prop, afterVal] of Object.entries(
                  element.after as Record<string, string>,
                )) {
                  const baseVal = (baselineStyles as Record<string, string>)[
                    prop
                  ];
                  if (baseVal !== afterVal) {
                    propDiff[prop] = [baseVal, afterVal as string];
                  }
                }
                if (Object.keys(propDiff).length > 0) {
                  pageDiff[key] = propDiff;
                }
              }
            }
            // Save updated allStyles with back-filled baselines
            saveFile(
              absProjectDir,
              taskId,
              "verify-all-styles.json",
              Buffer.from(JSON.stringify(afterPage, null, 2)),
            );
            // Save page diff
            const pageDiffJson = JSON.stringify(
              {
                totalChanged: Object.keys(pageDiff).length,
                elements: pageDiff,
              },
              null,
              2,
            );
            saveFile(
              absProjectDir,
              taskId,
              "verify-page-diff.json",
              Buffer.from(pageDiffJson),
            );
            evidenceFiles.push(
              join(getFilesDir(absProjectDir, taskId), "verify-page-diff.json"),
            );
          }
        } catch {
          // Page diff generation failed — not fatal
        }
      }
    }

    // ── 15. Build result ────────────────────────────────────────────────
    const result = buildResult(
      task.id,
      task.description,
      baseline,
      afterSnapshot,
      diff,
      evidenceFiles,
      selector,
    );

    // Mark task as verified only when verification passes (no selector issues, no console errors).
    // Persist the actual verdict: a failed re-verify must clear a stale pass,
    // otherwise the review gate accepts a task whose latest verification failed.
    updateTask(absProjectDir, taskId, { verified: result.ok });

    return result;
  } finally {
    await context?.close();
    await browser?.close();
  }
}

// ── Snapshot capture (§9.2 step 9) ────────────────────────────────────────
async function captureSnapshot(
  page: import("playwright").Page,
  selector: string,
  baseline: DomSnapshot,
  consoleErrors: string[],
): Promise<DomSnapshot> {
  const element = page.locator(selector).first();

  const outerHTML = await element
    .evaluate((el) => el.outerHTML)
    .catch(() => "");

  const computedStyles = await element
    .evaluate((el) => {
      const styles = window.getComputedStyle(el);
      const result: Record<string, string> = {};
      for (let i = 0; i < styles.length; i++) {
        const prop = styles[i];
        result[prop] = styles.getPropertyValue(prop);
      }
      return result;
    })
    .catch(() => ({}));

  const boundingBox = await element.boundingBox().catch(() => null);

  const position = {
    boundingBox: boundingBox ?? baseline.position.boundingBox,
    scrollPosition: await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
    })),
    viewport: await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    })),
    stackingContext: baseline.position.stackingContext,
  };

  return {
    outerHTML,
    computedStyles,
    selector,
    position,
    browser: baseline.browser,
    consoleErrors,
    capturedAt: new Date().toISOString(),
  };
}

// ── Evidence storage (§13.1) ──────────────────────────────────────────────
async function storeEvidence(
  projectDir: string,
  taskId: string,
  baseline: DomSnapshot,
  after: DomSnapshot,
  diff: DiffResult,
  consoleErrors: string[],
  page?: import("playwright").Page,
  selector?: string,
): Promise<string[]> {
  const files: string[] = [];

  // Clean up old evidence files before storing new ones
  const filesDir = getFilesDir(projectDir, taskId);
  try {
    const existing = readdirSync(filesDir);
    for (const f of existing) {
      if (f.startsWith("verify-") || f === "baseline.json") {
        unlinkSync(join(filesDir, f));
      }
    }
  } catch {
    /* dir doesn't exist yet — skip */
  }

  // verify-after.json
  const afterJson = JSON.stringify(after, null, 2);
  saveFile(projectDir, taskId, "verify-after.json", Buffer.from(afterJson));
  files.push(join(getFilesDir(projectDir, taskId), "verify-after.json"));

  // verify-diff.json
  const diffJson = JSON.stringify(diff, null, 2);
  saveFile(projectDir, taskId, "verify-diff.json", Buffer.from(diffJson));
  files.push(join(getFilesDir(projectDir, taskId), "verify-diff.json"));

  // verify-console.txt
  const consoleText =
    consoleErrors.length > 0 ? consoleErrors.join("\n") : "(no console errors)";
  saveFile(projectDir, taskId, "verify-console.txt", Buffer.from(consoleText));
  files.push(join(getFilesDir(projectDir, taskId), "verify-console.txt"));

  // Playwright artifacts (non-fatal if capture fails)
  if (page) {
    // verify-page.html
    try {
      const html = await page.content();
      saveFile(projectDir, taskId, "verify-page.html", Buffer.from(html));
      files.push(join(getFilesDir(projectDir, taskId), "verify-page.html"));
    } catch {
      // Capture failed — not fatal
    }

    // verify-all-styles.json — page-wide element styles for query tools
    // Uses shared helpers from page-selector.ts passed to page.evaluate()
    try {
      const MAX_ELEMENTS = 1000;
      const allStyles = await page.evaluate(
        ({
          buildKeyFn,
          buildSelectorFn,
          filterStylesFn,
          childSignatureFn,
          normalizeTextFn,
          styles,
          maxElements,
        }: {
          buildKeyFn: (el: Element) => string;
          buildSelectorFn: (el: Element) => string;
          filterStylesFn: (el: Element, s: string[]) => Record<string, string>;
          childSignatureFn: (c: Element[]) => string[];
          normalizeTextFn: (t: string) => string;
          styles: string[];
          maxElements: number;
        }) => {
          const elements: Record<string, unknown> = {};
          let count = 0;
          let truncated = false;
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            {
              acceptNode(node: Node) {
                if (count >= maxElements) return NodeFilter.FILTER_REJECT;
                const el = node as HTMLElement;
                if (
                  el.classList.length > 0 ||
                  el.hasAttribute("data-task-id") ||
                  el.hasAttribute("data-status") ||
                  el.hasAttribute("data-column-id")
                )
                  return NodeFilter.FILTER_ACCEPT;
                return NodeFilter.FILTER_SKIP;
              },
            },
          );
          const queue: Element[] = [];
          let n: Node | null;
          while ((n = walker.nextNode())) queue.push(n as Element);
          for (const el of queue) {
            if (count >= maxElements) {
              truncated = true;
              break;
            }
            const key = buildKeyFn(el);
            const children = Array.from(el.children);
            const dataAttrs: Record<string, string> = {};
            for (const a of Array.from(el.attributes)) {
              if (a.name.startsWith("data-"))
                dataAttrs[a.name.slice(5)] = a.value;
            }
            let position = { x: 0, y: 0, width: 0, height: 0 };
            try {
              const r = el.getBoundingClientRect();
              position = {
                x: Math.round(r.x),
                y: Math.round(r.y),
                width: Math.round(r.width),
                height: Math.round(r.height),
              };
            } catch {
              /* getBoundingClientRect can fail on hidden elements */
            }
            elements[key] = {
              key,
              selector: buildSelectorFn(el),
              tag: el.tagName.toLowerCase(),
              classes: Array.from(el.classList),
              dataAttrs,
              parentKey: el.parentElement ? buildKeyFn(el.parentElement) : "",
              childCount: children.length,
              childSignature: childSignatureFn(children),
              text: normalizeTextFn(el.textContent ?? ""),
              position,
              baseline: filterStylesFn(el, styles),
              after: filterStylesFn(el, styles),
            };
            count++;
          }
          return {
            version: 1,
            capturedAt: new Date().toISOString(),
            truncated,
            elements,
          };
        },
        {
          buildKeyFn: buildKey,
          buildSelectorFn: buildDisplaySelector,
          filterStylesFn: filterStyles,
          childSignatureFn: childSignature,
          normalizeTextFn: normalizeText,
          styles: RELEVANT_STYLES,
          maxElements: MAX_ELEMENTS,
        },
      );
      if (allStyles) {
        const json = JSON.stringify(allStyles, null, 2);
        saveFile(
          projectDir,
          taskId,
          "verify-all-styles.json",
          Buffer.from(json),
        );
        files.push(
          join(getFilesDir(projectDir, taskId), "verify-all-styles.json"),
        );
      }
    } catch {
      // Capture failed — not fatal
    }

    // verify-screenshot.png
    try {
      const screenshot = await page.screenshot({ fullPage: false });
      saveFile(projectDir, taskId, "verify-screenshot.png", screenshot);
      files.push(
        join(getFilesDir(projectDir, taskId), "verify-screenshot.png"),
      );
    } catch {
      // Capture failed — not fatal
    }

    // verify-element.html
    if (selector) {
      try {
        const elementHtml = await page
          .locator(selector)
          .first()
          .evaluate((el) => el.outerHTML);
        saveFile(
          projectDir,
          taskId,
          "verify-element.html",
          Buffer.from(elementHtml),
        );
        files.push(
          join(getFilesDir(projectDir, taskId), "verify-element.html"),
        );
      } catch {
        // Capture failed — not fatal
      }
    }
  }

  // baseline.json — the captured baseline snapshot
  if (baseline) {
    const baselineJson = JSON.stringify(baseline, null, 2);
    saveFile(projectDir, taskId, "baseline.json", Buffer.from(baselineJson));
    files.push(join(getFilesDir(projectDir, taskId), "baseline.json"));
  }

  return files;
}

// ── Result builder ────────────────────────────────────────────────────────
function buildResult(
  taskId: string,
  taskDescription: string,
  baseline: DomSnapshot,
  after: DomSnapshot,
  diff: DiffResult,
  evidenceFiles: string[],
  selector: string,
  overrideVerdict?: string,
): VerifyResult {
  const ok = diff.selectorResolves && diff.newConsoleErrors.length === 0;
  const verdict = overrideVerdict ?? summarizeDiff(diff, selector);

  return {
    taskId,
    ok,
    taskDescription,
    baseline: {
      selector: baseline.selector,
      url: "", // URL is on the task, not the snapshot
      capturedAt: baseline.capturedAt,
      snapshot: baseline,
    },
    after: {
      snapshot: after,
      consoleErrors: after.consoleErrors,
    },
    diff,
    evidenceFiles,
    verdict,
  };
}

// ── CLI command entry point ───────────────────────────────────────────────
export async function runVerify(
  dir: string,
  taskId: string,
  opts: { json?: boolean; url?: string },
): Promise<void> {
  const projectDir = resolve(dir);

  try {
    const result = await verifyTask(projectDir, taskId, opts);

    // Write system comment via the shared helper.
    await addVerifySystemComment(projectDir, taskId, result);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(result);
    }
  } catch (err) {
    if (err instanceof VerifyError) {
      if (opts.json) {
        process.stderr.write(
          JSON.stringify({
            ok: false,
            error: {
              code: err.code,
              message: err.message,
              suggestion: err.suggestion,
            },
          }) + "\n",
        );
      } else {
        process.stderr.write(chalk.red(`✗ ${err.message}\n`));
        if (err.suggestion) {
          process.stderr.write(chalk.dim(`  ${err.suggestion}\n`));
        }
      }
      process.exitCode = ExitCode.GENERAL;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        process.stderr.write(
          JSON.stringify({
            ok: false,
            error: { code: "E_UNKNOWN", message: msg },
          }) + "\n",
        );
      } else {
        process.stderr.write(chalk.red(`✗ Verification failed: ${msg}\n`));
      }
      process.exitCode = ExitCode.GENERAL;
    }
  }
}

/**
 * Write a system comment recording the verification result.
 * Extracted so the MCP path can call it without going through runVerify.
 */
export async function addVerifySystemComment(
  projectDir: string,
  taskId: string,
  result: VerifyResult,
): Promise<void> {
  const commentText = `**Verification ${result.ok ? "✅ passed" : "⚠️ issues detected"}**\n\n${result.verdict}`;
  addComment(projectDir, taskId, "agent", commentText, undefined, "system");
}

// ── Human-readable output ─────────────────────────────────────────────────
function printResult(result: VerifyResult): void {
  const statusIcon = result.ok ? chalk.green("✅") : chalk.yellow("⚠️");
  console.log();
  console.log(`  ${statusIcon} Evidences collected for task ${result.taskId}`);
  console.log(chalk.dim("─".repeat(60)));
  console.log(chalk.dim(`  Verdict: ${result.verdict}`));
  console.log();

  // Diff summary
  const d = result.diff;
  if (d.selectorResolves) {
    if (d.htmlChanged) {
      console.log(chalk.cyan("  ✓ HTML changed"));
    } else {
      console.log(chalk.dim("  · HTML unchanged"));
    }

    const styleCount = Object.keys(d.stylesChanged).length;
    if (styleCount > 0) {
      console.log(chalk.cyan(`  ✓ ${styleCount} style property change(s):`));
      for (const [prop, [from, to]] of Object.entries(d.stylesChanged).slice(
        0,
        8,
      )) {
        console.log(chalk.dim(`      ${prop}: ${from} → ${to}`));
      }
      if (styleCount > 8) {
        console.log(chalk.dim(`      ... and ${styleCount - 8} more`));
      }
    }

    if (d.positionChanged) {
      console.log(chalk.cyan("  ✓ Position shifted"));
    }

    if (d.newConsoleErrors.length > 0) {
      console.log(
        chalk.yellow(`  ⚠ ${d.newConsoleErrors.length} new console error(s):`),
      );
      for (const err of d.newConsoleErrors.slice(0, 3)) {
        console.log(chalk.dim(`      ${err.slice(0, 120)}`));
      }
    }
  } else {
    console.log(
      chalk.red(
        "  ⚠ Target element not found — the fix may have renamed/removed it.",
      ),
    );
  }

  if (result.evidenceFiles.length > 0) {
    console.log(
      chalk.cyan(`  Evidence files (${result.evidenceFiles.length}):`),
    );
    for (const f of result.evidenceFiles) {
      const name = f.split("/").pop() ?? f;
      try {
        const stats = statSync(f);
        const sizeKB = (stats.size / 1024).toFixed(1);
        console.log(chalk.dim(`    ${name} (${sizeKB} KB)`));
      } catch {
        console.log(chalk.dim(`    ${name}`));
      }
    }
  }
  console.log();
  console.log(chalk.cyan("  Explore evidence (agent tools):"));
  console.log(
    chalk.dim(`    vibeflow verify style_query ${result.taskId} <property>`),
  );
  console.log(
    chalk.dim(
      `    vibeflow verify style_diff ${result.taskId} [--filter <pattern>]`,
    ),
  );
  console.log(chalk.dim(`    vibeflow verify element_info ${result.taskId}`));
  console.log(chalk.dim(`    vibeflow verify html_diff ${result.taskId}`));
  console.log();
  console.log(chalk.cyan("  Review evidences:"));
  console.log(
    chalk.dim(
      "    1. Check if the fix is confirmed (styles match expectations)",
    ),
  );
  console.log(
    chalk.dim(
      `    2. If confirmed → vibeflow tasks --edit ${result.taskId} --set-status review --comment "Verified: <what you confirmed>"`,
    ),
  );
  console.log(
    chalk.dim("    3. If not sure → leave a comment explaining uncertainty"),
  );
  console.log(
    chalk.dim(
      `    4. If wrong → vibeflow tasks --edit ${result.taskId} --set-status in-progress`,
    ),
  );
  console.log();
  if (!result.ok) {
    console.log(
      chalk.yellow("  ⚠ Verification failed — move to in-progress and fix:"),
    );
    console.log(
      chalk.dim(
        `    vibeflow tasks --edit ${result.taskId} --set-status in-progress`,
      ),
    );
  }
}
