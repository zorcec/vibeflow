/**
 * Browser-side error reporting for the CLI kanban board (ticket 5087f5e3).
 *
 * Installs `window` `error` + `unhandledrejection` listeners (previously
 * absent — a board crash was silent) and forwards to the local
 * `POST /api/client-error` endpoint. The SERVER enforces the existing
 * telemetry flag (accept-and-drop 204 when off): the browser never reads
 * telemetry config and must not decide what leaves the machine.
 *
 * Client-side dedupe + cap mirror the server (one report per distinct
 * error, 20/min) so a broken render loop does not hammer localhost.
 * Fire-and-forget with `keepalive`; every failure path is silent — a
 * broken reporter must never break the board. Console errors are left
 * untouched (never preventDefault): `vibeflow verify` watches them.
 */

const CLIENT_REPORT_CAP = 20;
const CLIENT_REPORT_WINDOW_MS = 60_000;
/** Keep payloads small; the server scrub is authoritative. */
const CLIENT_MESSAGE_MAX = 2000;

const seenSignatures = new Map<string, number>();
const reportTimes: number[] = [];
let installed = false;

function prune(now: number): void {
  while (reportTimes.length > 0 && now - reportTimes[0]! > CLIENT_REPORT_WINDOW_MS) {
    reportTimes.shift();
  }
  for (const [sig, at] of seenSignatures) {
    if (now - at > CLIENT_REPORT_WINDOW_MS) seenSignatures.delete(sig);
  }
}

/** Test seam: resets dedupe state AND the install-once latch. */
export function resetKanbanErrorReportingForTests(): void {
  seenSignatures.clear();
  reportTimes.length = 0;
  installed = false;
}

export interface KanbanClientError {
  name: string;
  message: string;
  url?: string;
}

/** Forwards one error to the local endpoint. Resolves true when sent
 * (not when reported — the server decides that under the telemetry flag). */
export async function reportKanbanError(
  name: string,
  message: string,
  url?: string,
): Promise<boolean> {
  try {
    const cleanName = (name || "Error").slice(0, 80);
    const cleanMessage = (message || "Unknown error").slice(0, CLIENT_MESSAGE_MAX);
    const now = Date.now();
    prune(now);
    if (reportTimes.length >= CLIENT_REPORT_CAP) return false;
    const signature = `${cleanName}:${cleanMessage}`;
    if (seenSignatures.has(signature)) return false;
    seenSignatures.set(signature, now);
    reportTimes.push(now);
    const payload: KanbanClientError = { name: cleanName, message: cleanMessage };
    if (url) payload.url = url.slice(0, 500);
    await fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Survives a board crash / navigation mid-report.
      keepalive: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Idempotent: safe to call on every board boot. Never throws. */
export function installKanbanErrorReporting(): void {
  try {
    if (installed) return;
    if (typeof window === "undefined") return;
    installed = true;
    window.addEventListener("error", (event) => {
      try {
        const err =
          event instanceof ErrorEvent && event.error instanceof Error
            ? (event.error as Error)
            : null;
        void reportKanbanError(
          err?.name ?? "Error",
          err?.message ?? String(event.message ?? "Unknown error"),
          window.location.href,
        );
      } catch {
        /* reporter must never break the board */
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      try {
        const reason = (event as PromiseRejectionEvent).reason;
        void reportKanbanError(
          reason instanceof Error && reason.name ? reason.name : "UnhandledRejection",
          reason instanceof Error ? reason.message : String(reason),
          window.location.href,
        );
      } catch {
        /* reporter must never break the board */
      }
    });
  } catch {
    /* installation itself must never break the board */
  }
}
