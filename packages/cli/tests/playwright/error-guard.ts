/**
 * Ticket cba03995 (CLI counterpart of the private packages/web/tests/e2e/fixtures.ts
 * guard) — every CLI playwright spec that mints browser pages must fail on
 * console errors or failed requests.
 *
 * The CLI suite is vitest-driven (no Playwright fixtures), so the guard is an
 * explicit object: create ONE per browser context with `guardContext` (it
 * covers every page the context mints, present and future), or per page with
 * `guardPage` for `browser.newPage()` flows, and call `assertNoErrors()` in
 * an `afterEach` (shared-page files) or before closing the context/page
 * (inline-context tests):
 *
 * ```ts
 * import { guardContext, type ErrorGuard } from "./error-guard";
 *
 * let guard: ErrorGuard;
 * beforeAll(async () => { context = await browser.newContext(); guard = guardContext(context); });
 * afterEach(() => guard.assertNoErrors());
 * ```
 *
 * `assertNoErrors` drains what it reports, so a shared-page file attributes
 * each failure to the just-finished test. Expected failures are allow-listed
 * EXPLICITLY with a reason — never by blanket-ignoring output.
 *
 * Allow-lists are NAMED MAPS (`{ label: { pattern, reason } }`), mirroring
 * the private fixtures guard: the label doubles as the visible justification
 * for the exception, and unmatchable entries are rejected loudly instead of
 * silently matching nothing.
 */
import type { BrowserContext, Page } from "playwright";

export interface AllowedConsoleError {
  /** Matched against the console/pageerror text (substring for strings). */
  pattern: RegExp | string;
  /** WHY this failure is expected — required, shown in failure output. */
  reason: string;
}

export interface AllowedFailedRequest {
  /** Exact status to allow; omit to allow any status for the URL pattern. */
  status?: number;
  /** Matched against the request URL (substring for strings). */
  urlPattern?: RegExp | string;
  /** WHY this failure is expected — required, shown in failure output. */
  reason: string;
}

export interface ErrorGuardOptions {
  /** Named map — never an array; arrays are rejected loudly. */
  allowedConsoleErrors?: Record<string, AllowedConsoleError>;
  /** Named map — never an array; arrays are rejected loudly. */
  allowedFailedRequests?: Record<string, AllowedFailedRequest>;
}

export interface ErrorGuard {
  /** Throw if any console error or failed request was collected; drain them. */
  assertNoErrors(): void;
}

function matches(text: string, pattern: RegExp | string): boolean {
  return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
}

function asAllowList<T>(value: Record<string, T> | undefined, name: string): T[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    throw new Error(
      `[error-guard] ${name} must be a NAMED MAP ({ label: { pattern, reason } }), ` +
        "never an array: labels are the visible justification for each exception.",
    );
  }
  return Object.values(value);
}

/** Fail loud on unmatchable entries: a silently-dead pattern is a hole. */
function validateAllowLists(
  consoleErrors: AllowedConsoleError[],
  failedRequests: AllowedFailedRequest[],
): void {
  for (const [i, entry] of consoleErrors.entries()) {
    const pattern = (entry as AllowedConsoleError)?.pattern;
    const usable =
      typeof pattern === "string" ||
      (pattern instanceof RegExp && typeof pattern.test === "function");
    if (!usable || typeof (entry as AllowedConsoleError)?.reason !== "string") {
      throw new Error(
        `[error-guard] allowedConsoleErrors[${i}] is unusable ` +
          `(pattern must be a string or RegExp, and reason is required). ` +
          `Got: ${JSON.stringify(entry)?.slice(0, 160)}`,
      );
    }
  }
  for (const [i, entry] of failedRequests.entries()) {
    const urlPattern = (entry as AllowedFailedRequest)?.urlPattern;
    const usableUrl =
      urlPattern === undefined ||
      typeof urlPattern === "string" ||
      (urlPattern instanceof RegExp && typeof urlPattern.test === "function");
    if (
      !usableUrl ||
      typeof (entry as AllowedFailedRequest)?.reason !== "string" ||
      ((entry as AllowedFailedRequest)?.status === undefined && urlPattern === undefined)
    ) {
      throw new Error(
        `[error-guard] allowedFailedRequests[${i}] is unusable (needs a urlPattern and/or a status, plus a reason). ` +
          `Got: ${JSON.stringify(entry)?.slice(0, 160)}`,
      );
    }
  }
}

function createGuard(
  opts: ErrorGuardOptions = {},
): ErrorGuard & { attach: (page: Page) => void } {
  const allowedConsole = asAllowList(opts.allowedConsoleErrors, "allowedConsoleErrors");
  const allowedRequests = asAllowList(opts.allowedFailedRequests, "allowedFailedRequests");
  validateAllowLists(allowedConsole, allowedRequests);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const attached = new WeakSet<Page>();

  function attach(page: Page): void {
    if (attached.has(page)) return;
    attached.add(page);
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (allowedConsole.some((a) => matches(text, a.pattern))) return;
      consoleErrors.push(`[console.error] ${text.slice(0, 300)}`);
    });
    page.on("pageerror", (err) => {
      const text = err.message;
      if (allowedConsole.some((a) => matches(text, a.pattern))) return;
      consoleErrors.push(`[uncaught error] ${text.slice(0, 300)}`);
    });
    page.on("response", (response) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      const allowed = allowedRequests.some((a) => {
        if (a.status !== undefined && a.status !== status) return false;
        if (a.urlPattern !== undefined && !matches(url, a.urlPattern)) return false;
        return a.status !== undefined || a.urlPattern !== undefined;
      });
      if (allowed) return;
      failedRequests.push(`[${status}] ${response.request().method()} ${url.slice(0, 200)}`);
    });
  }

  return {
    attach,
    assertNoErrors() {
      const consolePart = consoleErrors.splice(0);
      const requestPart = failedRequests.splice(0);
      const parts: string[] = [];
      if (consolePart.length > 0) {
        parts.push(`Browser console errors:\n${consolePart.map((e) => `  • ${e}`).join("\n")}`);
      }
      if (requestPart.length > 0) {
        parts.push(`Failed requests:\n${requestPart.map((e) => `  • ${e}`).join("\n")}`);
      }
      if (parts.length > 0) throw new Error(parts.join("\n"));
    },
  };
}

/** Guard a whole context: existing pages plus every page it mints later. */
export function guardContext(context: BrowserContext, opts?: ErrorGuardOptions): ErrorGuard {
  const guard = createGuard(opts);
  for (const page of context.pages()) guard.attach(page);
  context.on("page", (page) => guard.attach(page));
  return guard;
}

/** Guard a single page (for `browser.newPage()` flows with no shared context). */
export function guardPage(page: Page, opts?: ErrorGuardOptions): ErrorGuard {
  const guard = createGuard(opts);
  guard.attach(page);
  return guard;
}
