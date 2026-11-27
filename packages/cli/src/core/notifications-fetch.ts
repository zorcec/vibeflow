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
 * to a board AND a token exists, local otherwise. The board the feed is read
 * from is the project's own pointer id (`resolveProjectAuth` sets
 * `workspaceId` to that pointer on the saas path, ADR-0005) — the same board a
 * write would land on.
 *
 * `since` is validated here, before either backend runs: an unparseable value
 * is `INVALID_SINCE`, never forwarded upstream as garbage.
 */
import { scopeHeaderFor } from "../auth/board-scope.js";
import { resolveProjectAuth } from "../auth/project-auth.js";
import { fetchWithTimeout } from "../saas/request.js";
import { getApiUrl } from "./api-url.js";
import { readConfig } from "./config.js";
import {
  readNotifications,
  type NotificationWaitSignal,
} from "./notifications.js";

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
 * Slack over the board's hold: the answer must arrive BEFORE the client's own
 * bounded fetch gives up, or a healthy long-poll would read as a failure.
 */
const WAIT_TRANSPORT_GRACE_MS = 10_000;

/** The local board's feed route; the hosted board serves the same body on v0. */
export const NOTIFICATIONS_LOCAL_PATH = "/api/notifications";

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
  /**
   * Ask the board to HOLD the read open for up to this long (ticket
   * olkwa34zghp22owchuhzaaba). Absent = the plain poll: the one behaviour an
   * OLD board understands, and therefore the fallback that must keep working.
   */
  waitMs?: number;
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
  /**
   * How a long-poll ended, PRESENT IFF the board honoured `?wait=` — the
   * explicit capability signal (ticket olkwa34zghp22owchuhzaaba). `undefined`
   * means the board ignored the parameter: an OLD board, so the caller falls
   * back to the 2 s poll. Never infer this from how long the request took.
   */
  longPoll?: NotificationWaitSignal;
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
 * credential simply has no access. The board id is the project's own pointer id
 * (`resolveProjectAuth` sets `workspaceId` to it on the saas path).
 */
export async function resolveOnlineAccess(
  projectDir: string,
): Promise<OnlineAccess | null> {
  try {
    const auth = await resolveProjectAuth(projectDir);
    if (auth.mode !== "saas" || !auth.token) return null;
    // ADR-0005: `mode: "saas"` implies a project pointer, and
    // `resolveProjectAuth` sets `workspaceId` to that pointer's id. A
    // `resolveBoardScope` re-read would return the same id (it short-circuits
    // on the pointer), so no board listing or 2+-board refusal can ever fire
    // here — there is nothing to fall back from. The board id is the pointer.
    return { token: auth.token, boardId: auth.workspaceId };
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
/**
 * The local board's origin. Same rule as the subscriber calls
 * (`notifications-subscribers.ts`): the SERVED port, which `serve` publishes
 * into `<project>/.vibeflow/config.json` — so a custom `-p <port>` is found
 * with no flag, and a port nobody is serving just fails the connect.
 */
function localOrigin(projectDir: string): string {
  return `http://localhost:${readConfig(projectDir).port}`;
}

/** The explicit `wait` signal, or `undefined` when the board sent none. */
function mapWaitSignal(value: unknown): NotificationWaitSignal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  // `released` is the field the contract is read through; a `wait` object
  // without it is not a signal and must not be mistaken for one.
  if (
    v.released !== "ready" &&
    v.released !== "event" &&
    v.released !== "timeout"
  ) {
    return undefined;
  }
  return {
    boundMs: typeof v.boundMs === "number" ? v.boundMs : 0,
    released: v.released,
  };
}

/**
 * A local read that can be HELD: ask the board, because only a running process
 * can be woken by an append (the file cannot call back). `null` means "no
 * usable answer here" — the board is not running, is an older build, or
 * answered something that is not a feed — and the caller falls back to the
 * plain file read, which is the whole point of the local store.
 */
async function readLocalBoard(
  projectDir: string,
  opts: FetchOptions,
): Promise<FetchResult | null> {
  const url = new URL(`${localOrigin(projectDir)}${NOTIFICATIONS_LOCAL_PATH}`);
  if (opts.since !== undefined) url.searchParams.set("since", opts.since);
  if (opts.limit !== undefined) {
    url.searchParams.set("limit", String(opts.limit));
  }
  if (opts.waitMs !== undefined) url.searchParams.set("wait", String(opts.waitMs));
  let res: Response;
  try {
    res = await request(
      opts.fetchImpl,
      url.toString(),
      {},
      (opts.waitMs ?? 0) + WAIT_TRANSPORT_GRACE_MS,
    );
  } catch {
    // No board on that port (or it dropped us): a normal state for a local
    // project, not a feed failure.
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const mapped = mapFeedBody("local", body);
  return mapped.ok ? mapped : null;
}

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
  timeoutMs?: number,
): Promise<Response> {
  if (fetchImpl) return fetchImpl(url, init);
  // pi-lens-ignore: ts-ssrf — url is getApiUrl()/localhost + a constant path
  return fetchWithTimeout(url, init, {
    phase: "GET (notifications)",
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/**
 * Map the board's answer onto {@link FetchResult}. A 200 without a
 * `notifications` array is MALFORMED, not empty: accepting it would resolve a
 * poll against a feed that was never sent, so it refuses instead.
 */
function mapFeedBody(
  target: NotificationTarget,
  body: unknown,
): FetchResult | FetchRefusal {
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
  const longPoll = mapWaitSignal(b.wait);
  return {
    ok: true,
    target,
    notifications,
    nextTs: typeof b.nextTs === "string" ? b.nextTs : null,
    earliestTs: typeof b.earliestTs === "string" ? b.earliestTs : null,
    gap: b.gap === true,
    truncated: b.truncated === true,
    count:
      typeof b.count === "number" && Number.isFinite(b.count)
        ? b.count
        : notifications.length,
    ...(longPoll !== undefined ? { longPoll } : {}),
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
  if (opts.waitMs !== undefined) url.searchParams.set("wait", String(opts.waitMs));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.token}`,
    ...scopeHeaderFor(access.boardId),
  };
  let res: Response;
  try {
    res = await request(
      opts.fetchImpl,
      url.toString(),
      { headers },
      (opts.waitMs ?? 0) + WAIT_TRANSPORT_GRACE_MS,
    );
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
  return mapFeedBody("online", body);
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
  if (target === "local") {
    if (opts.waitMs !== undefined) {
      const held = await readLocalBoard(projectDir, opts);
      // A board that answered is the only thing that can hold a request; with
      // none running (or an older build) the file read below is the fallback,
      // and the caller sleeps its poll interval because no `wait` came back.
      if (held !== null) return held;
    }
    return readLocal(projectDir, opts);
  }
  if (access === null) {
    return {
      ok: false,
      code: "NOT_AUTHENTICATED",
      message: `Not connected to a board — ${projectDir} has no linked board credential. Run \`vibeflow auth login\` in it, or read the local feed instead.`,
    };
  }
  return readOnline(access, opts);
}
