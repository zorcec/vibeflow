/**
 * How a `--follow` follower survives the network (ticket liolbrdi).
 *
 * A follower is a long-lived reader, so the interesting question is never
 * "did this one request work" but "what should a reader do about it". Three
 * answers, and only three:
 *
 * - **retry** — transport failures, timeouts, 5xx, 408, 429. The feed is fine,
 *   the path to it was not. Retry with bounded exponential backoff and FULL
 *   jitter: without jitter, every follower woken by the same outage retries on
 *   the same beat and turns a blip into a thundering herd; with full jitter the
 *   expected spread is the whole window.
 * - **recover** — the cursor itself expired (`INVALID_SINCE`). This is not an
 *   error to retry; it is a typed instruction to discard client state and
 *   resume from now, exactly as a resumable-stream client does with an expired
 *   position. Retrying the same cursor forever is the classic bug.
 * - **stop** — the answer will not change by waiting: no project link
 *   (`NOT_CONNECTED`), a usage refusal, or a 401/403/422. A bad credential is
 *   not a transient condition, and a follower that retries it forever is a
 *   busy loop with a friendly face.
 *
 * Anything not recognised as terminal is retried: for a notifier, a wrongly
 * retried request costs a little traffic, while a wrongly abandoned follower
 * costs every notification after it — silence is the expensive failure.
 */
import type { FetchRefusal } from "./notifications-fetch.js";

export type { FetchRefusal };

/** First backoff step; the cap keeps a long outage from sleeping for hours. */
export const NOTIFICATIONS_RETRY_BASE_MS = 500;
export const NOTIFICATIONS_RETRY_CAP_MS = 30_000;

/**
 * How many delivered event ids are remembered for de-duplication. The feed is
 * at-least-once (inclusive `since`), so a short memory is required; an
 * unbounded one is a leak in a process meant to run for days.
 */
export const NOTIFICATIONS_DEDUPE_WINDOW = 1_000;

/** HTTP statuses that mean "ask again later", never "you are wrong". */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Bounded exponential backoff with full jitter.
 *
 * `attempt` is 1-based (1 = the first failure). Full jitter — a uniform draw
 * over `[0, ceiling]` rather than `ceiling/2 + random/2` — is the variant that
 * actually decorrelates clients, at the cost of sometimes retrying almost
 * immediately; for a 2 s poll loop that is the right trade.
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const step = Math.max(1, Math.trunc(attempt));
  const ceiling = Math.min(
    NOTIFICATIONS_RETRY_CAP_MS,
    NOTIFICATIONS_RETRY_BASE_MS * 2 ** (step - 1),
  );
  return Math.round(random() * ceiling);
}

/** `INVALID_SINCE`: reset the cursor, do not retry it. */
export function isCursorExpired(refusal: FetchRefusal): boolean {
  return refusal.code === "INVALID_SINCE";
}

/**
 * True when waiting cannot help. Kept as an allow-list of KNOWN-transient
 * conditions rather than a list of known-fatal ones: an unrecognised failure
 * (a new code, a proxy error nobody anticipated) is retried, because a
 * notifier that goes quiet is worse than one that retries too hard.
 */
export function isTerminalNotificationFailure(refusal: FetchRefusal): boolean {
  if (refusal.code === "NOT_CONNECTED" || refusal.code === "E_USAGE") return true;
  const status = refusal.status;
  if (status === undefined) return false; // transport/timeout: retry
  if (RETRYABLE_STATUS.has(status)) return false;
  // 4xx that is not "later": the credential, the scope or the request is wrong.
  return status >= 400 && status < 500;
}

/**
 * How long to wait before the next attempt: the `Retry-After` the board asked
 * for when it gave one (capped, so a hostile header cannot park the follower),
 * else the backoff step.
 */
export function retryDelayMs(
  refusal: FetchRefusal,
  attempt: number,
  random: () => number = Math.random,
): number {
  const asked = refusal.retryAfterMs;
  if (typeof asked === "number" && Number.isFinite(asked) && asked > 0) {
    return Math.min(NOTIFICATIONS_RETRY_CAP_MS, Math.max(0, asked));
  }
  return backoffDelayMs(attempt, random);
}
