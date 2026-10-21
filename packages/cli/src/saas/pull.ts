/**
 * Pull transport: the board → local HTTP seam for `vibeflow pull`.
 *
 * WHAT: one POST per pull —
 * `POST /api/v0/tasks/export/archive?boardId=<boardId>`, Bearer-authed,
 * board-scoped exactly like the push (`scopeHeadersFromSaved()`), answering
 * `application/gzip`. This module only moves bytes: it returns the raw
 * archive (or the raw refusal) and decides NOTHING about the local store —
 * unpacking, verification and the additive merge live in `pull-archive.ts`.
 *
 * WHY the retry posture mirrors the push: a retry can only fix a transient
 * failure (a dropped connection, a 429, a 502/503/504). A refusal — 401/403
 * auth, 403 EXPORT_NOT_ALLOWED (plan gate), 413 EXPORT_TOO_LARGE (cap),
 * 404/422 scope — answers the same on a second attempt, so retrying it is a
 * loop that only burns rate-limit budget. The mapping itself lives in
 * `saas/failure.ts` (`saasFailure` reads the body's `serverCode` first, so a
 * plan refusal is never mislabelled as an auth failure); this module only
 * decides retryable vs not.
 */

export const PULL_ARCHIVE_PATH = "/api/v0/tasks/export/archive";

/** Response-body text cap returned to callers: enough to render a refusal,
 * not enough to buffer a whole error page. Same 500-char convention as the
 * delta-push sender. */
const MAX_RESULT_BODY_CHARS = 500;

export interface PullFetchArgs {
  apiUrl: string;
  token: string;
  headers: Record<string, string>;
  boardId: string;
  fetchImpl?: typeof fetch;
}

export type PullFetchResult =
  | { ok: true; bytes: Buffer }
  | {
      ok: false;
      status: number | null;
      /** The backend's own refusal code (`{ error, code }` body), if any. */
      serverCode: string | null;
      body: string;
      retryable: boolean;
    };

/**
 * Status codes worth a second attempt: the rate-limit and the transient
 * gateway failures. Everything else (401/403/404/413/422/…) is a refusal —
 * the server will answer the same way again.
 */
export function isPullRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Read the v0 `{ error, code }` envelope's code, or null when absent. */
export function readPullServerCode(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown };
    return typeof parsed.code === "string" && parsed.code.length > 0
      ? parsed.code
      : null;
  } catch {
    return null;
  }
}

/**
 * One pull attempt: POST the export endpoint, buffer the gzipped archive on
 * success, or return the refusal (status + server code + truncated body).
 * A transport throw (DNS, refused connection, reset) is returned — NOT
 * thrown — as a retryable `{ status: null }` failure, so the retry loop and
 * the command share one shape. Retries nothing itself; see
 * `fetchPullArchiveWithRetry`.
 */
export async function fetchPullArchive(
  args: PullFetchArgs,
): Promise<PullFetchResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `${args.apiUrl}${PULL_ARCHIVE_PATH}?boardId=${encodeURIComponent(args.boardId)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.token}`, ...args.headers },
    });
  } catch (err) {
    return {
      ok: false,
      status: null,
      serverCode: null,
      body: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
  if (!res.ok) {
    const status = res.status;
    const body = (await res.text().catch(() => "")).slice(
      0,
      MAX_RESULT_BODY_CHARS,
    );
    return {
      ok: false,
      status,
      serverCode: readPullServerCode(body),
      body,
      retryable: isPullRetryableStatus(status),
    };
  }
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
}

/**
 * POST the export endpoint, retrying ONLY transient failures (a throw, or a
 * 429/502/503/504) with a short backoff. Refusals return immediately — a
 * second attempt cannot change a plan gate, a cap, or a scope rejection.
 * `sleepMs` is the base backoff (tests inject 0); attempts past
 * `maxAttempts` return the last failure as-is.
 */
export async function fetchPullArchiveWithRetry(
  args: PullFetchArgs,
  opts?: { maxAttempts?: number; sleepMs?: number },
): Promise<PullFetchResult> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const sleepMs = opts?.sleepMs ?? 500;
  let last: PullFetchResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fetchPullArchive(args);
    if (result.ok || !result.retryable) return result;
    last = result;
    if (attempt < maxAttempts && sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs * attempt));
    }
  }
  return last ?? { ok: false, status: null, serverCode: null, body: "", retryable: true };
}
