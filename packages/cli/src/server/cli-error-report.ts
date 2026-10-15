/**
 * CLI kanban error instrumentation (ticket 5087f5e3).
 *
 * Catches server + process + forwarded client errors and reports them as
 * PostHog `cli_error` events tagged `environment: "cli"`. EVERY report path
 * consults the EXISTING telemetry flag (`isTelemetryEnabled()` in
 * `../telemetry.js`) — no second flag exists; when it is off everything is
 * accepted-and-dropped and nothing is sent.
 *
 * Scrub rules (privacy: board errors routinely carry task titles, absolute
 * paths and project names — none of that may leave the machine):
 *   1. Collapse whitespace, coerce non-errors to text.
 *   2. `$HOME` → `~` (removes the username embedded in home paths).
 *   3. Absolute POSIX paths → their basename (`/a/b/c.json` → `c.json`),
 *      except api-route-like runs (`/api/tasks`) and URLs, which stay.
 *   3b. Hex run IDs (task IDs) and UUIDs → `[id]` — telemetry.ts bars
 *      shipping task IDs alongside paths and content.
 *   4. Windows absolute paths → their basename.
 *   5. Email addresses → `[email]`.
 *   6. Quoted spans of 12+ chars → `[text]` (task titles, comments and
 *      selectors arrive quoted inside ENOENT/validation messages; short
 *      quoted tokens like HTTP methods are kept).
 *   7. Truncate to CLI_ERROR_MESSAGE_MAX chars.
 * Client stacks are NEVER accepted: the endpoint reads name/message/url
 * only, extra fields are dropped — stacks carry absolute paths and
 * bundled source context.
 *
 * Rate limit + dedupe (mirrors the web's 20/min precedent): one report per
 * distinct signature per 60s window, hard cap of 20 reports per window per
 * process, so a broken render loop cannot produce hundreds of events.
 */
import type express from "express";
import os from "node:os";
import { capture, flushTelemetry, isTelemetryEnabled } from "../telemetry.js";

/** PostHog event name for CLI error reports. */
export const CLI_ERROR_EVENT = "cli_error";

/** Max chars of scrubbed message shipped per event. */
export const CLI_ERROR_MESSAGE_MAX = 300;

/** Hard session cap per 60s window (mirrors the web's 20/min precedent). */
export const CLI_ERROR_SESSION_CAP = 20;

const CLI_ERROR_WINDOW_MS = 60_000;

export type CliErrorSource = "server" | "client" | "process";

export interface CliErrorContext {
  source: CliErrorSource;
  /** Express route path (server) or page path (client). Query/hash stripped. */
  route?: string;
  statusCode?: number;
  /** True for uncaughtException / unhandledRejection. */
  unhandled?: boolean;
}

/**
 * Scrub raw error text before it may leave the machine. Pure — unit-tested
 * with a realistic path-and-title error in cli-error-scrub.test.ts.
 */
export function scrubErrorText(input: unknown): string {
  let text: string;
  if (input === null || input === undefined) return "Unknown error";
  if (input instanceof Error) text = `${input.name}: ${input.message}`;
  else if (typeof input === "string") text = input;
  else {
    try {
      text = String(input);
    } catch {
      return "Unknown error";
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "Unknown error";

  // 2. Home dir first (it is a prefix of most absolute paths below).
  const home = os.homedir();
  if (home) text = text.split(home).join("~");

  // 4. Windows absolute paths → basename (before POSIX: `C:\a\b` has no `/`).
  text = text.replace(
    /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]*)/g,
    (_m, tail: string) => tail || "[path]",
  );
  // 3. Absolute POSIX paths (incl. `~`-rooted) → basename, EXCEPT
  // api-route-like runs (`/api/tasks`: every segment a plain lowercase
  // word) which carry no PII and stay readable. The offset guard keeps
  // `http(s)://host/…` URLs intact.
  text = text.replace(
    /~?(?:\/[A-Za-z0-9._~-]+){2,}/g,
    (m, offset: number, full: string) => {
      const prev = offset > 0 ? full[offset - 1] : "";
      if (prev && /[:\w.~/-]/.test(prev)) return m;
      const segs = m.split("/").filter((s) => s !== "" && s !== "~");
      if (segs.length === 0) return m;
      if (segs.every((s) => /^[a-z][a-z-]*$/.test(s))) return m;
      return segs[segs.length - 1] ?? "[path]";
    },
  );
  // 3b. Task/hex IDs are identifiers telemetry must not ship either
  // (telemetry.ts: "No file paths, task IDs, or content") — redact hex
  // runs of 8+ chars and UUIDs, keeping a `.json`-style tail readable.
  text = text
    .replace(/\b[0-9a-f]{8,}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b[0-9a-f]{8,}\b/gi, "[id]");
  // 5. Emails (user identifiers).
  text = text.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[email]",
  );
  // 6. Long quoted spans (task titles, comments, selectors) → [text].
  text = text.replace(/"[^"]{12,}"/g, '"[text]"').replace(/'[^']{12,}'/g, "'[text]'");

  // 7. Truncate.
  if (text.length > CLI_ERROR_MESSAGE_MAX) {
    text = `${text.slice(0, CLI_ERROR_MESSAGE_MAX - 1)}…`;
  }
  return text;
}

// ── Rate limit + dedupe ─────────────────────────────────────────────

const reportTimes: number[] = [];
const recentSignatures = new Map<string, number>();

function pruneLocked(now: number): void {
  while (reportTimes.length > 0 && now - reportTimes[0]! > CLI_ERROR_WINDOW_MS) {
    reportTimes.shift();
  }
  for (const [sig, at] of recentSignatures) {
    if (now - at > CLI_ERROR_WINDOW_MS) recentSignatures.delete(sig);
  }
}

/** Test seam: clears the session window so flag/dedupe tests are isolated. */
export function resetCliErrorReportState(): void {
  reportTimes.length = 0;
  recentSignatures.clear();
}

function signatureFor(
  source: CliErrorSource,
  name: string,
  message: string,
  route?: string,
): string {
  return `${source}:${name}:${route ?? "-"}:${message}`;
}

/**
 * Report one error through the existing telemetry sink. Returns true when an
 * event was actually captured (false = flag off, duplicate, or capped).
 * The ONLY writer to the `cli_error` event — server middleware, process
 * handlers and the client-error endpoint all funnel through here.
 */
export function reportCliError(raw: unknown, context: CliErrorContext): boolean {
  if (!isTelemetryEnabled()) return false;
  const name =
    raw instanceof Error && raw.name ? raw.name : "UnknownError";
  const message = scrubErrorText(
    raw instanceof Error ? raw.message : raw,
  );
  const now = Date.now();
  pruneLocked(now);
  if (reportTimes.length >= CLI_ERROR_SESSION_CAP) return false;
  const signature = signatureFor(context.source, name, message, context.route);
  if (recentSignatures.has(signature)) return false;
  recentSignatures.set(signature, now);
  reportTimes.push(now);
  capture(CLI_ERROR_EVENT, {
    environment: "cli",
    source: context.source,
    error_name: name,
    error_message: message,
    ...(context.route ? { route: context.route } : {}),
    ...(context.statusCode !== undefined
      ? { status_code: context.statusCode }
      : {}),
    ...(context.unhandled ? { unhandled: true } : {}),
  });
  return true;
}

// ── Process handlers ────────────────────────────────────────────────

/** Unhandled promise rejection: report, then log-and-CONTINUE. A rejected
 * promise does not corrupt the event loop the way a sync throw can, so
 * crashing the locally-run dev board on every stray rejection would hide
 * less than it costs — the report preserves the signal. */
export function handleUnhandledRejection(reason: unknown): void {
  reportCliError(reason, { source: "process", unhandled: true });
}

let processHandlersInstalled = false;

/**
 * Uncaught exception: report, flush telemetry, then EXIT(1).
 * Log-and-continue is deliberately NOT an option here — a sync throw can
 * leave the locally-hosted dev server on corrupted state, and silently
 * serving from that state is worse than a visible crash. `exit` is an
 * injectable seam (defaults to process.exit) so tests can assert the
 * crash semantics without killing the runner.
 */
export function handleUncaughtException(
  err: unknown,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  reportCliError(err, { source: "process", unhandled: true });
  void flushTelemetry().finally(() => exit(1));
}

/** Idempotent: safe to call from every serve entrypoint in one process. */
export function installCliProcessErrorHandlers(): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.on("unhandledRejection", handleUnhandledRejection);
  process.on("uncaughtException", handleUncaughtException);
}

/** Test seam: lets the suite install twice across module reloads. */
export function resetCliProcessErrorHandlersForTests(): void {
  processHandlersInstalled = false;
}

// ── Client-error endpoint ───────────────────────────────────────────

/**
 * `POST /api/client-error` — the browser cannot use posthog-node and must
 * not read telemetry config, so it forwards here and the server enforces
 * the flag. ALWAYS 204: accept-and-drop when telemetry is off (never an
 * error, never a leak), report-and-204 when on. Only name/message/url are
 * read — stacks and any other fields are dropped unread. The message is
 * scrubbed again server-side (authoritative; the client only truncates).
 */
export function registerClientErrorRoute(app: express.Application): void {
  app.post("/api/client-error", (req, res) => {
    if (!isTelemetryEnabled()) {
      res.status(204).end();
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawMessage =
      typeof body.message === "string" ? body.message : "Unknown error";
    const name =
      typeof body.name === "string" && body.name
        ? body.name.slice(0, 80)
        : "Error";
    const err = new Error(rawMessage);
    err.name = name;
    const rawUrl = typeof body.url === "string" ? body.url : undefined;
    // Strip query + hash: deep links carry `#task-<id>` fragments.
    const route = rawUrl?.split(/[?#]/)[0]?.slice(0, 200);
    reportCliError(err, { source: "client", route });
    res.status(204).end();
  });
}
