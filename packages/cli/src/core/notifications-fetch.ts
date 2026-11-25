/**
 * Notification feed read — ONE result shape over the two backends an agent can
 * poll (ticket ae96cee7, parent 4e4feca1).
 *
 * - `local` reads `<projectDir>/.vibeflow/notifications.jsonl` through
 *   {@link readNotifications} (the store the CLI and the board both write), so
 *   it works whether or not a board is running.
 * - `online` asks the linked board `GET {apiUrl}/api/v0/notifications`, with
 *   the project's OWN token (ADR-0005: project-scoped, never an ambient
 *   credential) and the same board-scope header every other v0 request
 *   carries. It FAILS CLOSED: a transport or non-2xx answer is an error, never
 *   a silent local read — a caller that asked for the board must never be
 *   shown a different feed.
 *
 * Target resolution is one rule, no discovery: an explicit `target` wins;
 * otherwise the project's own auth decides — online when the project is linked
 * to a board AND a token exists, local otherwise. `resolveBoardScope` is the
 * same helper the write paths use, so the board the feed is read from is the
 * board a write would land on; when it resolves nothing (an unusual pointer
 * read failure) the credential's own workspace id scopes the request, exactly
 * as `saas/client.ts` builds it.
 *
 * `since` is validated here, before either backend runs: an unparseable value
 * is `INVALID_SINCE`, never forwarded upstream as garbage.
 */
import { resolveBoardScope, scopeHeaderFor } from "../auth/board-scope.js";
import { resolveProjectAuth } from "../auth/project-auth.js";
import { fetchWithTimeout } from "../saas/request.js";
import { getApiUrl } from "./api-url.js";
import { readNotifications } from "./notifications.js";

/** Which feed a read targets. */
export type NotificationTarget = "local" | "online";

/**
 * How often `--follow` polls, in milliseconds. One spelling: the CLI loop and
 * the tests that bound its wait read this constant.
 */
export const NOTIFICATIONS_POLL_INTERVAL_MS = 2000;

/** The v0 route of the feed. The local board serves the same body on `/api/notifications`. */
export const NOTIFICATIONS_V0_PATH = "/api/v0/notifications";

/**
 * The refusal text for an unparseable `since`. Mirrors the board route's own
 * 400 body (`GET /api/notifications`), so the CLI and the board name the same
 * format and the same example.
 */
export const INVALID_SINCE_MESSAGE =
  "`since` must be an ISO-8601 UTC timestamp with milliseconds, exactly as returned in `nextTs` — e.g. 2026-11-22T16:58:45.140Z. Omit `since` to read the newest events instead.";

/**
 * Transport seam: the production path is `fetchWithTimeout` (bounded, never
 * retried); tests inject their own and assert the request it built.
 */
export type FetchTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface FetchOptions {
  /** Explicit backend; absent = resolved from the project's own auth. */
  target?: NotificationTarget;
  /** Inclusive ISO timestamp — pass the previous answer's `nextTs`. */
  since?: string;
  /** Page size; the store keeps the NEWEST `limit` matches. */
  limit?: number;
  /** Test seam (see {@link FetchTransport}); production uses the bounded fetch. */
  fetchImpl?: FetchTransport;
}

export interface FetchResult {
  ok: true;
  target: NotificationTarget;
  notifications: unknown[];
  /** Pass back as `since` on the next poll; null when there is no cursor. */
  nextTs: string | null;
  /** Oldest event the feed still holds; null when empty. */
  earliestTs: string | null;
  /** True iff `since` predates what is still stored — re-read, do not page. */
  gap: boolean;
  /** True iff more events matched than `limit` allowed (the newest win). */
  truncated: boolean;
  count: number;
}

export interface FetchRefusal {
  ok: false;
  code: string;
  message: string;
  /**
   * The HTTP status when the board answered at all. Absent for a transport
   * failure or a timeout — a distinction a follower needs: a 401 will never
   * fix itself by waiting, a dropped socket will.
   */
  status?: number;
  /** `Retry-After`, in ms, when the board asked for a specific wait. */
  retryAfterMs?: number;
}

/** The project's own access to its board: no token, no online read. */
export interface OnlineAccess {
  token: string;
  /** The board the feed is read from (null = the server's own default). */
  boardId: string | null;
}

/**
 * The project's own online access — the ONE probe behind both auto-resolution
 * and the online request. Never throws: a project with no pointer or no
 * credential simply has no access (and a failed board-scope lookup only means
 * the request falls back to the credential's own workspace id).
 */
export async function resolveOnlineAccess(
  projectDir: string,
): Promise<OnlineAccess | null> {
  try {
    const auth = await resolveProjectAuth(projectDir);
    if (auth.mode !== "saas" || !auth.token) return null;
    // The same board the write paths resolve. A failed listing or a 2+-board
    // refusal leaves the request unscoped and the server authoritative (its
    // own 403/422 becomes NOTIFICATIONS_FETCH_FAILED below — never a guess).
    const boardId = await resolveBoardScope(null, projectDir).catch(() => null);
    return { token: auth.token, boardId: boardId ?? auth.workspaceId };
  } catch {
    return null;
  }
}

/** `since` must be a date before it reaches either backend (or the wire). */
function validateSince(since: string | undefined): FetchRefusal | null {
  if (since === undefined) return null;
  if (Number.isNaN(Date.parse(since))) {
    return { ok: false, code: "INVALID_SINCE", message: INVALID_SINCE_MESSAGE };
  }
  return null;
}

/** Local read — the JSONL store, straight through {@link readNotifications}. */
function readLocal(projectDir: string, opts: FetchOptions): FetchResult {
  const read = readNotifications(projectDir, {
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  return {
    ok: true,
    target: "local",
    notifications: read.notifications,
    nextTs: read.nextTs,
    earliestTs: read.earliestTs,
    gap: read.gap,
    truncated: read.truncated,
    count: read.count,
  };
}

/**
 * `Retry-After` → milliseconds. Delta-seconds is the common form; an HTTP date
 * is the other legal one. A value that is neither (or is negative) is dropped
 * rather than guessed at — the follower's own backoff then decides.
 */
function retryAfterFrom(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const delta = at - Date.now();
  return delta > 0 ? delta : 0;
}

/** One request: the injected transport in tests, the bounded fetch everywhere else. */
function request(
  fetchImpl: FetchTransport | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (fetchImpl) return fetchImpl(url, init);
  // pi-lens-ignore: ts-ssrf — url is getApiUrl() + the constant v0 path
  return fetchWithTimeout(url, init, { phase: "GET (notifications)" });
}

/**
 * Map the board's answer onto {@link FetchResult}. A 200 without a
 * `notifications` array is MALFORMED, not empty: accepting it would resolve a
 * poll against a feed that was never sent, so it refuses instead.
 */
function mapOnlineBody(body: unknown): FetchResult | FetchRefusal {
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      code: "NOTIFICATIONS_FETCH_FAILED",
      message:
        "The board answered the notification feed without a body — refusing rather than reporting an empty feed that was never sent.",
    };
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.notifications)) {
    return {
      ok: false,
      code: "NOTIFICATIONS_FETCH_FAILED",
      message:
        "The board answered the notification feed without a `notifications` list — refusing rather than reporting an empty feed that was never sent.",
    };
  }
  const notifications = b.notifications as unknown[];
  return {
    ok: true,
    target: "online",
    notifications,
    nextTs: typeof b.nextTs === "string" ? b.nextTs : null,
    earliestTs: typeof b.earliestTs === "string" ? b.earliestTs : null,
    gap: b.gap === true,
    truncated: b.truncated === true,
    count:
      typeof b.count === "number" && Number.isFinite(b.count)
        ? b.count
        : notifications.length,
  };
}

/** Online read — one request, fail closed on transport, status or shape. */
async function readOnline(
  access: OnlineAccess,
  opts: FetchOptions,
): Promise<FetchResult | FetchRefusal> {
  const url = new URL(`${getApiUrl()}${NOTIFICATIONS_V0_PATH}`);
  if (opts.since !== undefined) url.searchParams.set("since", opts.since);
  if (opts.limit !== undefined) {
    url.searchParams.set("limit", String(opts.limit));
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.token}`,
    ...scopeHeaderFor(access.boardId),
  };
  let res: Response;
  try {
    res = await request(opts.fetchImpl, url.toString(), { headers });
  } catch (err) {
    return {
      ok: false,
      code: "NOTIFICATIONS_FETCH_FAILED",
      message: `Notification feed request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!res.ok) {
    // `Retry-After` is the one instruction the board can give about WHEN, and
    // only a retryable status can carry a useful one. Seconds or an HTTP date;
    // anything unparseable is simply absent (the caller's backoff decides).
    const retryAfterMs = retryAfterFrom(res.headers?.get("retry-after"));
    return {
      ok: false,
      code: "NOTIFICATIONS_FETCH_FAILED",
      message: `Notification feed request failed: HTTP ${res.status}`,
      status: res.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      code: "NOTIFICATIONS_FETCH_FAILED",
      message: `Notification feed answered with an unreadable body: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return mapOnlineBody(body);
}

/**
 * Read the notification feed for one project.
 *
 * `opts.target` absent = the resolved backend (see the module comment). An
 * explicit `online` read on a project that is not connected to a board is a
 * `NOT_AUTHENTICATED` refusal — never a silent local read.
 */
export async function fetchNotifications(
  projectDir: string,
  opts: FetchOptions,
): Promise<FetchResult | FetchRefusal> {
  const invalidSince = validateSince(opts.since);
  if (invalidSince) return invalidSince;
  const access = await resolveOnlineAccess(projectDir);
  const target = opts.target ?? (access === null ? "local" : "online");
  if (target === "local") return readLocal(projectDir, opts);
  if (access === null) {
    return {
      ok: false,
      code: "NOT_AUTHENTICATED",
      message: `Not connected to a board — ${projectDir} has no linked board credential. Run \`vibeflow auth login\` in it, or read the local feed instead.`,
    };
  }
  return readOnline(access, opts);
}
