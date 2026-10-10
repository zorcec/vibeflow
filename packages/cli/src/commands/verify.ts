import chalk from "chalk";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { statSync, readdirSync, unlinkSync } from "node:fs";
import { findTaskFilePath, readTaskFile } from "../core/tasks.js";
import { saveFile, getFilesDir, getFilePath } from "../core/files.js";
import { addComment } from "../core/comments.js";
import { decryptAuthState, type EncryptedAuthState } from "../core/auth.js";
import { computeDiff, summarizeDiff } from "../core/diff.js";
import type { DomSnapshot, DiffResult } from "../core/diff.js";
import { ExitCode } from "../core/exit-codes.js";
import { readConfig } from "../core/config.js";
import { RELEVANT_STYLES } from "../core/page-selector.js";

/** Hard cap on page-wide captured elements — keeps evidence files manageable. */
export const MAX_ELEMENTS = 1000;

/**
 * Warning shown when the page-wide capture hit MAX_ELEMENTS.
 *
 * A capped capture is a silent subset: the diff only sees the first
 * MAX_ELEMENTS elements, so "no changes" for anything beyond the cap proves
 * nothing. The agent must never read this result as a clean pass.
 */
export function captureTruncationWarning(maxElements: number): string {
  return `WARNING: capture truncated at ${maxElements} elements — elements beyond the cap were NOT compared. "No change" results for those elements are unreliable.`;
}

// ── Served-build fingerprint — WHICH build the evidence measured ───────────

/** Placeholder used wherever a fingerprint cannot be established. Never a match. */
export const UNKNOWN_BUILD = "unknown";

/**
 * Which build the verify evidence measured — EVIDENCE ONLY.
 *
 * A green run against a board that is still serving an OLD bundle looks exactly
 * like a green run against the build under test: the page is real, the selector
 * resolves, and the measured code is not the code in the working tree. Recording
 * WHICH build was measured makes that blind spot visible; it does not close it.
 * The fingerprint never feeds `result.ok`, the verdict, or the attestation
 * model — it is one more piece of evidence the agent judges.
 */
export interface ServedBuildFingerprint {
  /** sha256 over the asset inputs. `"unknown"` when the page exposes none. */
  hash: string;
  /** Version/build stamp the served document exposes ("unknown" when none). */
  version: string;
  /** External asset URLs in document order (content-hashed when emitted). */
  assetUrls: string[];
  /** Which input produced `hash` — says what a difference actually means. */
  source: "inline-assets" | "asset-urls" | "none";
  capturedAt: string;
}

/**
 * Outcome of comparing the build the baseline evidence belongs to with the
 * build this run measured.
 *
 * `"unknown"` is deliberately NOT a match: a side that could not be measured
 * cannot vouch for the other side, so verify stays silent instead of green.
 */
export type ServedBuildComparison =
  | "match" // both sides measured the same build
  | "mismatch" // two builds — the evidence spans a rebuild
  | "no-reference" // nothing was recorded with the baseline to compare against
  | "unknown"; // a side is unmeasurable

/** Raw, unhashed asset surface of a served document (read inside the page). */
export interface ServedAssetInputs {
  version: string;
  assetUrls: string[];
  inlineAssets: string[];
}

/** Build pair a verify result reports: measured now vs. the baseline evidence. */
export interface ServedBuildPair {
  after: ServedBuildFingerprint | null;
  baseline: ServedBuildFingerprint | null;
}

/** Compiled, printable view of a result's build pair. */
export interface ServedBuildReport {
  comparison: ServedBuildComparison;
  baseline: ServedBuildFingerprint | null;
  after: ServedBuildFingerprint | null;
  /** One-line summary for the output and the system comment. */
  line: string;
  /** The loud mismatch warning, or null when the builds agree (or can't be compared). */
  warning: string | null;
}

/**
 * Read the asset surface of the SERVED document — runs INSIDE the page.
 *
 * Self-contained by requirement: Playwright serializes this function's source
 * and evaluates it in the browser, so it may not close over imports or module
 * state, and it must tolerate a document it cannot inspect (it then returns the
 * empty input set, which composes into an explicit "unknown" fingerprint).
 *
 * Two inputs, because together they are the only build-identifying surface the
 * CLI board exposes — it serves ONE HTML document with the JS bundle and CSS
 * inlined, so there are no content-hashed asset URLs to read:
 *   1. external asset URLs (`<script src>`, stylesheet / modulepreload links),
 *      which is where a Next-style app's hashed chunk names would appear,
 *   2. the text of every inline `<script>` / `<style>`.
 *
 * Inline scripts that only assign `window.__*` globals are skipped: that is the
 * shell's per-request runtime configuration (port, user, version), so it changes
 * with the environment rather than the build and would report a "rebuild" that
 * never happened. Its version stamp is read separately below.
 */
export function collectServedAssetInputs(): ServedAssetInputs {
  // Self-contained ON PURPOSE: `page.evaluate` ships this function's SOURCE
  // into the browser, so it must not close over module scope. A module-scope
  // constant referenced from here is undefined in the page and throws — which
  // silently degraded every REAL fingerprint to "unknown" (the catch in
  // captureServedBuildFingerprint swallowed it) while the unit tests stayed
  // green, because they call this function directly in Node where the module
  // constant IS in scope. Keep every value it needs inside the function.
  const unknown = "unknown";
  const empty = (): ServedAssetInputs => ({
    version: unknown,
    assetUrls: [],
    inlineAssets: [],
  });
  if (typeof document === "undefined") return empty();

  function readVersionStamp(): string {
    // SAFETY: the served shell stamps its version onto the global object with
    // app-specific names (`window.__CLI_VERSION__`, `window.__NEXT_DATA__`,
    // `window.__BUILD_ID__`), none of which exist in the DOM typings. Reading
    // them off a loose record and type-checking each value before use keeps
    // the read honest without asserting a shape that is not guaranteed.
    const w = window as unknown as Record<string, unknown>;
    const cli = w.__CLI_VERSION__;
    if (typeof cli === "string" && cli.length > 0) return cli;
    const next = w.__NEXT_DATA__ as { buildId?: unknown } | undefined;
    if (next && typeof next.buildId === "string" && next.buildId.length > 0)
      return next.buildId;
    const buildId = w.__BUILD_ID__;
    if (typeof buildId === "string" && buildId.length > 0) return buildId;
    const meta =
      typeof document === "undefined"
        ? null
        : document.querySelector('meta[name="build-id"]');
    const fromMeta = meta?.getAttribute("content");
    return fromMeta && fromMeta.length > 0 ? fromMeta : unknown;
  }

  try {
    const assetUrls: string[] = [];
    const external = document.querySelectorAll<HTMLElement>(
      'script[src], link[rel~="stylesheet"][href], link[rel~="modulepreload"][href]',
    );
    for (const node of Array.from(external)) {
      const url = node.getAttribute("src") ?? node.getAttribute("href");
      if (url) assetUrls.push(url);
    }

    const inlineAssets: string[] = [];
    const inline = document.querySelectorAll<HTMLElement>(
      "script:not([src]), style",
    );
    for (const node of Array.from(inline)) {
      const text = (node.textContent ?? "").trim();
      if (!text) continue;
      if (text.startsWith("window.__")) continue; // runtime config, not build content
      inlineAssets.push(text);
    }

    return { version: readVersionStamp(), assetUrls, inlineAssets };
  } catch {
    return empty();
  }
}

/**
 * Compose the fingerprint from the collected inputs.
 *
 * `hashText` is injected so the digest stays on the Node side (the page only
 * reports asset text) and so tests can pin the hash without re-implementing
 * it. A page exposing neither asset URLs nor inline assets yields an explicit
 * "unknown": verify never invents a fingerprint, because a fabricated one
 * would turn the blind spot into a lie.
 */
export function buildServedBuildFingerprint(
  inputs: ServedAssetInputs,
  hashText: (text: string) => string,
): ServedBuildFingerprint {
  const assetUrls = inputs.assetUrls ?? [];
  const inlineAssets = inputs.inlineAssets ?? [];
  const version =
    typeof inputs.version === "string" && inputs.version.length > 0
      ? inputs.version
      : UNKNOWN_BUILD;
  const capturedAt = new Date().toISOString();

  if (assetUrls.length === 0 && inlineAssets.length === 0) {
    return {
      hash: UNKNOWN_BUILD,
      version,
      assetUrls: [],
      source: "none",
      capturedAt,
    };
  }

  return {
    hash: hashText(JSON.stringify({ assetUrls, inlineAssets })),
    version,
    assetUrls,
    source: inlineAssets.length > 0 ? "inline-assets" : "asset-urls",
    capturedAt,
  };
}

/** sha256 hex — the fingerprint digest. Same input, same hash, every run. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Measure the served-build fingerprint of the page verify just loaded.
 * Degrades to "unknown" — never to a guess, and never to a throw: a failed
 * measurement must not cost the run its evidence.
 */
export async function captureServedBuildFingerprint(
  page: import("playwright").Page,
): Promise<ServedBuildFingerprint> {
  try {
    const inputs = await page.evaluate(collectServedAssetInputs);
    return buildServedBuildFingerprint(inputs, sha256Hex);
  } catch {
    return {
      hash: UNKNOWN_BUILD,
      version: UNKNOWN_BUILD,
      assetUrls: [],
      source: "none",
      capturedAt: new Date().toISOString(),
    };
  }
}

/**
 * Compare the build the baseline evidence belongs to with the build this run
 * measured. `"unknown"` is never reported as a match.
 */
export function compareServedBuilds(
  baseline: ServedBuildFingerprint | null | undefined,
  after: ServedBuildFingerprint | null | undefined,
): ServedBuildComparison {
  // This run's own measurement comes first: a build that could not be
  // fingerprinted is the more severe fact, and it must not be reportable as
  // "nothing to compare" — the reader needs to know the run is blind.
  if (!after || after.hash === UNKNOWN_BUILD) return "unknown";
  if (!baseline || baseline.hash === UNKNOWN_BUILD) return "no-reference";
  return baseline.hash === after.hash && baseline.version === after.version
    ? "match"
    : "mismatch";
}

/** Short display form of a fingerprint (the full hash lives in the JSON). */
function describeBuild(fp: ServedBuildFingerprint): string {
  const hash = fp.hash === UNKNOWN_BUILD ? UNKNOWN_BUILD : fp.hash.slice(0, 16);
  const via =
    fp.source === "none"
      ? "nothing fingerprintable"
      : fp.source === "inline-assets"
        ? "inline bundle + CSS"
        : "asset URLs";
  return `${hash} · version ${fp.version} · via ${via}`;
}

/**
 * The loud line for a baseline/after build mismatch — the point of the whole
 * mechanism. It reports that the evidence spans a rebuild; it does NOT report
 * that the task is wrong, and it must never be read as a verdict.
 */
export function servedBuildMismatchWarning(
  baseline: ServedBuildFingerprint,
  after: ServedBuildFingerprint,
): string {
  return [
    "BUILD MISMATCH: this evidence spans TWO builds — the board was rebuilt between the baseline measurement and this run.",
    `  build the baseline evidence measured : ${baseline.hash} (version ${baseline.version}, via ${baseline.source})`,
    `  build this run measured               : ${after.hash} (version ${after.version}, via ${after.source})`,
    "  What this warning does NOT mean: it does NOT mean the task is wrong, and it does NOT fail the run or set a verdict.",
    '  What it DOES mean: "HTML unchanged" / "no style changes" below compares code against different code, so it proves nothing about the feature.',
    "  Fix: restart the board process (a reload does NOT pick up a rebuilt bundle), then re-run verify so both sides measure one build.",
  ].join("\n");
}

/**
 * Compile a result's build pair into the line the output and the system comment
 * print, plus the mismatch warning when the evidence spans a rebuild.
 * Tolerates a result built before the fingerprint existed (no `servedBuild`).
 */
export function servedBuildReport(result: {
  servedBuild?: ServedBuildFingerprint | null;
  baselineBuild?: ServedBuildFingerprint | null;
  buildComparison?: ServedBuildComparison;
}): ServedBuildReport {
  const after = result.servedBuild ?? null;
  const baseline = result.baselineBuild ?? null;
  const comparison =
    result.buildComparison ?? compareServedBuilds(baseline, after);

  // Either side unmeasurable → ONE plain line, no warning. The reason is
  // spelled out in words a reader can act on, never as an internal state token
  // ("no-reference", "unknown") that means nothing outside this module.
  if (!after || after.hash === UNKNOWN_BUILD) {
    return {
      comparison: "unknown",
      baseline,
      after,
      line:
        "Cannot compare builds: the served page exposes no version stamp, hashed asset URLs or inline app bundle, so which build this evidence measured cannot be determined.",
      warning: null,
    };
  }

  if (comparison === "no-reference") {
    return {
      comparison,
      baseline,
      after,
      line:
        "Cannot compare builds: no earlier verify run recorded a build for this task, so this is the first one — re-run after a rebuild to catch a change.",
      warning: null,
    };
  }

  if (comparison === "unknown") {
    return {
      comparison,
      baseline,
      after,
      line:
        "Cannot compare builds: the build recorded with the baseline evidence could not be read, so this run has nothing sound to compare against.",
      warning: null,
    };
  }

  const measured = describeBuild(after);
  if (comparison === "mismatch" && baseline) {
    return {
      comparison,
      baseline,
      after,
      line: `Served build measured: ${measured} — this is NOT the build the baseline evidence was measured against.`,
      warning: servedBuildMismatchWarning(baseline, after),
    };
  }

  // A match is quiet on purpose: it is the uninteresting case.
  return {
    comparison,
    baseline,
    after,
    line: `Served build measured: ${measured} — the same build the baseline evidence was measured against.`,
    warning: null,
  };
}

/** Filename of the baseline evidence copy that anchors the build reference. */
const BASELINE_EVIDENCE_FILE = "baseline.json";

/**
 * The build the baseline evidence belongs to, as recorded by an earlier run.
 *
 * Anchored, not refreshed every run: the fingerprint is written once per
 * baseline snapshot and kept while that snapshot is still the reference, so a
 * rebuild produces ONE mismatch and the next run against the fixed board reads
 * "match" again. Re-annotating (a different `capturedAt`) re-anchors it.
 *
 * verify cannot know the build the annotation-time baseline was captured from —
 * the overlay owns that capture and records no fingerprint — so the first run
 * after a baseline is what anchors the reference, and that run reports
 * "no-reference" instead of pretending to have one. A reference that cannot be
 * read is no reference, never a match.
 */
function readStoredBaselineBuild(
  projectDir: string,
  taskId: string,
  baseline: DomSnapshot,
): ServedBuildFingerprint | null {
  const path = getFilePath(projectDir, taskId, BASELINE_EVIDENCE_FILE);
  if (!path) return null;
  try {
    const stored = JSON.parse(readFileSync(path, "utf-8")) as {
      servedBuild?: ServedBuildFingerprint;
      servedBuildBaselineCapturedAt?: string;
    };
    const storedBuild = stored?.servedBuild;
    if (!storedBuild || typeof storedBuild.hash !== "string") return null;
    if (stored.servedBuildBaselineCapturedAt !== baseline.capturedAt)
      return null;
    return storedBuild;
  } catch {
    return null;
  }
}

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
  /**
   * True when the page-wide capture exceeded MAX_ELEMENTS. The diff is then a
   * partial view and MUST NOT be read as a clean pass.
   */
  captureTruncated: boolean;
  /**
   * The served build this run measured — WHICH build the evidence describes.
   * Evidence only: it never affects `ok`, the verdict, or the attestation.
   */
  servedBuild: ServedBuildFingerprint;
  /**
   * The build the baseline evidence belongs to (null when none was recorded).
   */
  baselineBuild: ServedBuildFingerprint | null;
  /**
   * baseline vs. measured build. "mismatch" means the evidence spans a rebuild
   * and the diff below compares two different builds.
   */
  buildComparison: ServedBuildComparison;
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

/**
 * `VerifyError` codes where "fix the cause and re-run" is misleading — the run
 * cannot be retried as-is: the task id is missing/invalid, or the user
 * cancelled the run.
 */
const NON_RETRYABLE_VERIFY_CODES = new Set(["E_CANCELLED", "E_NOT_FOUND"]);

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
  opts: { json?: boolean; url?: string; signal?: AbortSignal } = {},
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
      // verify can only compare against a baseline it captured, so this refusal
      // is not retryable as-is — the recovery is to produce the missing input.
      "Annotate the element on the running prototype and capture a baseline (vibeflow kanban, then re-run verify), or verify against a different task",
    );
  }

  // The build the baseline evidence belongs to. Read here, before any evidence
  // write: the reference lives in `baseline.json`, which storeEvidence cleans up
  // and rewrites later in this same run.
  const baselineBuild = readStoredBaselineBuild(absProjectDir, task.id, baseline);

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
  if (opts.signal?.aborted)
    throw new VerifyError("E_CANCELLED", "Verification cancelled.");
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

    // WHICH build this evidence measures. Captured straight after navigation
    // — the served shell is fixed by then, and every return path below reports
    // it, including the selector-not-found paths that store no files.
    const servedBuild = await captureServedBuildFingerprint(page);

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
        undefined,
        false,
        servedBuild,
        baselineBuild,
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
        undefined,
        servedBuild,
        baselineBuild,
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
      } catch (err) {
        warnEvidenceCapture(`page baseline ${pageBaselineFile}`, err);
      }
    }

    // ── 13. Compute structural diff ─────────────────────────────────────
    const diff = computeDiff(baseline, afterSnapshot);

    // ── 13. Store evidence files ────────────────────────────────────────
    const { files: evidenceFiles, pageTruncated } = await storeEvidence(
      absProjectDir,
      taskId,
      baseline,
      afterSnapshot,
      diff,
      consoleErrors,
      page,
      selector,
      servedBuild,
      baselineBuild,
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
                // Compute per-property diff. Compare ONLY properties present on
                // both sides — an after-only property is a capture asymmetry,
                // not a value change (same rule as computeDiff).
                const baseStyles = baselineStyles as Record<string, string>;
                const propDiff: Record<string, [string, string]> = {};
                for (const [prop, afterVal] of Object.entries(
                  element.after as Record<string, string>,
                )) {
                  if (!Object.hasOwn(baseStyles, prop)) continue;
                  const baseVal = baseStyles[prop];
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
              { system: true },
            );
            // Save page diff
            const pageDiffJson = JSON.stringify(
              {
                totalChanged: Object.keys(pageDiff).length,
                // Carry the snapshot's real truncation state into the page diff
                // so a consumer of this file cannot mistake a capped subset for
                // the whole page.
                truncated: afterPage.truncated === true,
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
              { system: true },
            );
            evidenceFiles.push(
              join(getFilesDir(absProjectDir, taskId), "verify-page-diff.json"),
            );
          }
        } catch (err) {
          warnEvidenceCapture("verify-page-diff.json", err);
        }
      }
    }

    // ── 15. Build result ────────────────────────────────────────────────
    // `result.ok` is evidence, NOT a verdict: it reports whether the annotated
    // element still resolves and whether the page logged NEW console errors.
    // It cannot tell whether the task was accomplished, so verify stops here
    // and writes nothing — the AGENT judges correctness and attests with
    // `--set-verify pass|fail|cannot` at the review transition (see
    // core/verify-attestation.ts and core/review-gate.ts Gate 4).
    return buildResult(
      task.id,
      task.description,
      baseline,
      afterSnapshot,
      diff,
      evidenceFiles,
      selector,
      undefined,
      pageTruncated,
      servedBuild,
      baselineBuild,
    );
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

  // Capture the SAME property set as the annotation baseline.
  //
  // The baseline is captured by the overlay via `filterStyles(el,
  // RELEVANT_STYLES)`. This path used to enumerate ALL computed styles
  // (~476-609 properties in chromium), so `computeDiff` reported every
  // after-only property as a `"" -> value` change — a no-op page produced
  // hundreds of false changes. The property list is passed as a plain array
  // argument (serializable); the loop lives inside the callback because
  // Playwright serializes the function source and cannot resolve imports.
  const computedStyles = await element
    .evaluate((el, props: string[]) => {
      const styles = window.getComputedStyle(el);
      const result: Record<string, string> = {};
      for (const prop of props) {
        result[prop] = styles.getPropertyValue(prop);
      }
      return result;
    }, RELEVANT_STYLES)
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

/**
 * Record a non-fatal evidence-capture failure.
 *
 * Capture failures used to be swallowed by bare `catch {}` blocks, which hid
 * the page-wide capture defect for months. Never hide them again.
 */
function warnEvidenceCapture(file: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(chalk.yellow(`  ⚠ Could not capture ${file}: ${msg}`));
}

/**
 * Page-wide capture callback for `page.evaluate()`.
 *
 * Playwright serializes this function's SOURCE and evaluates it in the browser,
 * so it must be fully self-contained: every helper is declared inside and the
 * only argument is plain, JSON-serializable data. Passing helper functions as
 * arguments throws "Attempting to serialize unexpected value", which silently
 * disabled `verify-all-styles.json` and every page-wide query tool.
 *
 * The inlined helpers mirror `page-selector.ts` (buildKey, buildDisplaySelector,
 * filterStyles, childSignature, normalizeText) in behaviour.
 */
export function capturePageWideElements(input: {
  styles: string[];
  maxElements: number;
}): {
  version: 1;
  capturedAt: string;
  truncated: boolean;
  elements: Record<string, unknown>;
} {
  const { styles, maxElements } = input;

  function buildKey(el: Element): string {
    const path: number[] = [];
    let current: Element | null = el;
    while (current && current !== document.documentElement) {
      const parentEl: HTMLElement | null = current.parentElement;
      if (!parentEl) break;
      const index = Array.from(parentEl.children).indexOf(current as Element);
      path.unshift(index);
      current = parentEl;
    }
    return path.join("/");
  }

  function buildDisplaySelector(el: Element): string {
    const tag = el.tagName.toLowerCase();

    const taskId = el.getAttribute("data-task-id");
    if (taskId) return `${tag}.task-card[data-task-id=${taskId}]`;

    const status = el.getAttribute("data-status");
    if (status && el.classList.contains("column-scroll"))
      return `${tag}.column-scroll[data-status=${status}]`;

    const colId = el.getAttribute("data-column-id");
    if (colId) return `${tag}[data-column-id=${colId}]`;

    const classes = Array.from(el.classList).slice(0, 2);
    let selector = tag;
    if (classes.length) selector += "." + classes.join(".");

    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === el.tagName,
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(el) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }

    return selector;
  }

  function filterStyles(el: Element, props: string[]): Record<string, string> {
    const computed = window.getComputedStyle(el);
    const result: Record<string, string> = {};
    for (const prop of props) {
      result[prop] = computed.getPropertyValue(prop);
    }
    return result;
  }

  function normalizeText(text: string, limit = 200): string {
    return text.replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function childSignature(children: Element[]): string[] {
    const counts = new Map<string, number>();
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      const classes = Array.from(child.classList).slice(0, 2).join(".");
      const key = classes ? `${tag}.${classes}` : tag;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([key, count]) => `${key} ×${count}`)
      .slice(0, 10);
  }

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
    const key = buildKey(el);
    const children = Array.from(el.children);
    const dataAttrs: Record<string, string> = {};
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith("data-")) dataAttrs[a.name.slice(5)] = a.value;
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
      selector: buildDisplaySelector(el),
      tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList),
      dataAttrs,
      parentKey: el.parentElement ? buildKey(el.parentElement) : "",
      childCount: children.length,
      childSignature: childSignature(children),
      text: normalizeText(el.textContent ?? ""),
      position,
      baseline: filterStyles(el, styles),
      after: filterStyles(el, styles),
    };
    count++;
  }
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    truncated,
    elements,
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
  servedBuild?: ServedBuildFingerprint,
  baselineBuild?: ServedBuildFingerprint | null,
): Promise<{ files: string[]; pageTruncated: boolean }> {
  const files: string[] = [];
  // Whether the page-wide capture hit MAX_ELEMENTS. Read from the snapshot it
  // writes, not recomputed — the snapshot is the single source of truth.
  let pageTruncated = false;

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

  // verify-after.json — carries the measured build so the evidence JSON itself
  // records WHICH build it describes (a stale-board read is otherwise invisible
  // in the files, only in the terminal).
  const afterJson = JSON.stringify({ ...after, servedBuild }, null, 2);
  saveFile(projectDir, taskId, "verify-after.json", Buffer.from(afterJson), {
    system: true,
  });
  files.push(join(getFilesDir(projectDir, taskId), "verify-after.json"));

  // verify-diff.json
  const diffJson = JSON.stringify(diff, null, 2);
  saveFile(projectDir, taskId, "verify-diff.json", Buffer.from(diffJson), {
    system: true,
  });
  files.push(join(getFilesDir(projectDir, taskId), "verify-diff.json"));

  // verify-console.txt
  const consoleText =
    consoleErrors.length > 0 ? consoleErrors.join("\n") : "(no console errors)";
  saveFile(projectDir, taskId, "verify-console.txt", Buffer.from(consoleText), {
    system: true,
  });
  files.push(join(getFilesDir(projectDir, taskId), "verify-console.txt"));

  // Playwright artifacts (non-fatal if capture fails)
  if (page) {
    // verify-page.html
    try {
      const html = await page.content();
      saveFile(projectDir, taskId, "verify-page.html", Buffer.from(html), {
        system: true,
      });
      files.push(join(getFilesDir(projectDir, taskId), "verify-page.html"));
    } catch (err) {
      warnEvidenceCapture("verify-page.html", err);
    }

    // verify-all-styles.json — page-wide element styles for query tools.
    // The callback is serialized by Playwright and evaluated in the page, so it
    // is fully self-contained (helpers inlined) and receives plain data only.
    try {
      const allStyles = await page.evaluate(capturePageWideElements, {
        styles: RELEVANT_STYLES,
        maxElements: MAX_ELEMENTS,
      });
      if (allStyles) {
        pageTruncated = allStyles.truncated === true;
        const json = JSON.stringify(allStyles, null, 2);
        saveFile(
          projectDir,
          taskId,
          "verify-all-styles.json",
          Buffer.from(json),
          { system: true },
        );
        files.push(
          join(getFilesDir(projectDir, taskId), "verify-all-styles.json"),
        );
      }
    } catch (err) {
      warnEvidenceCapture("verify-all-styles.json", err);
    }

    // verify-screenshot.webp — capture-time image matrix (T1 pipeline):
    // wide viewports (>1920px) resize to 1920 + WebP q80, narrow PNG
    // screenshots transcode to lossless WebP. Stored under its TRUE
    // extension; falls back to the raw PNG bytes when the transform fails.
    try {
      const screenshot = await page.screenshot({ fullPage: false });
      let shotName = "verify-screenshot.webp";
      let shotBytes: Buffer = screenshot;
      try {
        const { transformImageBytes } = await import(
          "../server/imageNodeCodecs.js"
        );
        const out = await transformImageBytes(new Uint8Array(screenshot), {
          filename: "verify-screenshot.png",
          mimeType: "image/png",
        });
        shotName = out.filename;
        shotBytes = Buffer.from(out.bytes);
      } catch {
        shotName = "verify-screenshot.png";
      }
      saveFile(projectDir, taskId, shotName, shotBytes, {
        system: true,
      });
      files.push(join(getFilesDir(projectDir, taskId), shotName));
    } catch (err) {
      warnEvidenceCapture("verify-screenshot.webp", err);
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
          { system: true },
        );
        files.push(
          join(getFilesDir(projectDir, taskId), "verify-element.html"),
        );
      } catch (err) {
        warnEvidenceCapture("verify-element.html", err);
      }
    }
  }

  /**
   * baseline.json — the captured baseline snapshot.
  
   * The stored `servedBuild` anchors the baseline's build: written once per
   * baseline snapshot (see `readStoredBaselineBuild`), so a later run measures
   * against the build the baseline belongs to and a rebuild in between shows
   * up as one mismatch.
   */
  if (baseline) {
    const anchored = baselineBuild ?? servedBuild;
    const baselineJson = JSON.stringify(
      {
        ...baseline,
        ...(anchored ? { servedBuild: anchored } : {}),
        servedBuildBaselineCapturedAt: baseline.capturedAt,
      },
      null,
      2,
    );
    saveFile(projectDir, taskId, "baseline.json", Buffer.from(baselineJson), {
      system: true,
    });
    files.push(join(getFilesDir(projectDir, taskId), "baseline.json"));
  }

  return { files, pageTruncated };
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
  captureTruncated = false,
  servedBuild?: ServedBuildFingerprint,
  baselineBuild?: ServedBuildFingerprint | null,
): VerifyResult {
  const ok = diff.selectorResolves && diff.newConsoleErrors.length === 0;
  const verdict = overrideVerdict ?? summarizeDiff(diff, selector);

  const measured = servedBuild ?? {
    hash: UNKNOWN_BUILD,
    version: UNKNOWN_BUILD,
    assetUrls: [],
    source: "none" as const,
    capturedAt: new Date().toISOString(),
  };

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
    captureTruncated,
    servedBuild: measured,
    baselineBuild: baselineBuild ?? null,
    buildComparison: compareServedBuilds(
      baselineBuild ?? null,
      measured,
    ),
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
        // Tell the agent the run is not finished: fix the cause and retry.
        // Skipped when retrying cannot help (missing/invalid task id, or a
        // run the user cancelled).
        if (!NON_RETRYABLE_VERIFY_CODES.has(err.code)) {
          process.stderr.write(
            chalk.yellow(
              `  Fix the issues above, then re-run: vibeflow verify ${taskId}\n`,
            ),
          );
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
        process.stderr.write(
          chalk.yellow(
            `  Fix the issues above, then re-run: vibeflow verify ${taskId}\n`,
          ),
        );
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
  const truncation = result.captureTruncated
    ? `> **${captureTruncationWarning(MAX_ELEMENTS)}**\n\n`
    : "";
  // The measured build travels with the evidence: the JSON and the terminal
  // line are per-run, and this comment is what survives on the task.
  const build = servedBuildReport(result);
  // Blockquoted so the mismatch survives the task's markdown renderer: a
  // multi-line run needs a `>` on every line, not one at the top.
  const buildBlock = build.warning
    ? `${build.warning
        .split("\n")
        .map((line, i) => (i === 0 ? `> **${line}**` : `> ${line}`))
        .join("\n")}\n\n`
    : "";
  const commentText = `**Page-health evidence: ${result.ok ? "✅ clean (element resolves, no new console errors)" : "⚠️ not clean"}**\n\n${truncation}${buildBlock}**Served build:** ${build.line}\n\n_verify collects evidence only — it does not set a verdict. The agent judges correctness and attests with \`--set-verify pass|fail|cannot\`._\n\n${result.verdict}`;
  addComment(projectDir, taskId, "agent", commentText, undefined, "system");
}

// ── Human-readable output ─────────────────────────────────────────────────
export function printResult(result: VerifyResult): void {
  const statusIcon = result.ok ? chalk.green("✅") : chalk.yellow("⚠️");
  console.log();
  console.log(`  ${statusIcon} Evidences collected for task ${result.taskId}`);
  console.log(chalk.dim("─".repeat(60)));
  // Printed before the evidence itself: a capped capture makes every "no
  // change" line below unsound, so the agent must read this first.
  if (result.captureTruncated) {
    console.log(chalk.yellow.bold(`  ${captureTruncationWarning(MAX_ELEMENTS)}`));
    console.log();
  }
  // A build mismatch can invalidate every "unchanged" line below, so it is
  // announced up here where it cannot be skipped past.
  const build = servedBuildReport(result);
  if (build.warning) {
    console.log(chalk.red.bold(`  ⚠ ${build.warning}`));
    console.log();
  }
  // `ok` is a page-health signal, printed as EVIDENCE, not as a verdict.
  console.log(
    `  Page-health evidence (result.ok): ${result.ok ? chalk.green("true") : chalk.yellow("false")}`,
  );
  console.log(
    chalk.dim(
      "  ok = the annotated element still resolves AND the page logged no NEW console errors.",
    ),
  );
  console.log(
    chalk.dim(
      "  That is all it proves — it CANNOT tell whether you did what the task asked.",
    ),
  );
  console.log(
    chalk.dim(
      "  verify does NOT set a verdict; YOU judge correctness and attest with --set-verify pass|fail|cannot.",
    ),
  );
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

  // WHICH build this evidence measured, next to the evidence paths: a green
  // run against a board still serving an old bundle is otherwise
  // indistinguishable from a green run against the build under test.
  //
  // Mismatch is loud and comes first; a match is deliberately quiet — it is
  // the uninteresting case, and shouting it would train the reader to skip
  // the line that matters.
  if (build.comparison === "mismatch") {
    console.log(chalk.yellow.bold(`  ${build.line}`));
  } else {
    console.log(chalk.dim(`  ${build.line}`));
  }
  console.log(
    chalk.dim(
      "  The build fingerprint is EVIDENCE about which code was measured — it never changes the verdict.",
    ),
  );

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
  // Imperative, not reference: agents whose eyes are already on this output
  // must reach for these tools BEFORE hand-parsing the evidence files above.
  // The sub-commands inspect STATIC captured evidence only — hover/focus/
  // behavioral states still need a live check (headless Playwright against
  // a fresh build).
  console.log(
    chalk.cyan(
      "  Before reading evidence files by hand, explore them with:",
    ),
  );
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
  console.log(
    chalk.dim(
      "    These inspect STATIC captured evidence only — hover/focus/behavior still needs a live check (headless Playwright against a fresh build).",
    ),
  );
  console.log();
  console.log(chalk.cyan("  Next — the correctness verdict is YOURS to make:"));
  console.log(
    chalk.dim(
      "    1. Compare the evidence above with what the task actually asked for.",
    ),
  );
  console.log(
    chalk.dim(
      `    2. Implemented correctly → vibeflow tasks --edit ${result.taskId} --set-status review --set-verify pass --comment "<what you confirmed>"`,
    ),
  );
  console.log(
    chalk.dim(
      "       --set-verify pass is your attestation; the review gate requires a verdict on annotated tasks.",
    ),
  );
  console.log(
    chalk.dim(
      `    3. Implemented WRONG → record it and go back to fix it: --set-status in-progress --set-verify fail`,
    ),
  );
  console.log(
    chalk.dim(
      "       Cannot verify here? → --set-status review --set-verify cannot --verify-reason \"<why>\"",
    ),
  );
  console.log(chalk.dim("       Never submit work you know is incomplete."));
  console.log(
    chalk.dim("    4. Not sure → leave a comment explaining the uncertainty"),
  );
  console.log();
  if (!result.ok) {
    console.log(
      chalk.yellow(
        "  ⚠ Page-health evidence is not clean — fix the issues above, then re-run:",
      ),
    );
    console.log(chalk.dim(`    vibeflow verify ${result.taskId}`));
  }
}
