/**
 * Bounded SaaS transport primitive (ticket d13fa9f5).
 *
 * Every native `fetch` on the online path previously had no deadline: a
 * stalled headers/body exchange hung the command forever (measured: one
 * `tasks --add` killed after 15 minutes). All online call sites route
 * through `fetchWithTimeout`, which aborts the transport at the deadline
 * and raises a typed timeout naming the PHASE and the redacted URL.
 *
 * Policy, recorded here so it is not silently retuned:
 * - DEFAULT 30s per ordinary JSON request, headers AND body. A bound on
 *   each request, not on the whole command: a paged hydration legitimately
 *   costs N bounded requests. Conservative initial bound — measure real
 *   latencies before tightening.
 * - UPLOAD 120s for binary/multipart file uploads only (slow-uplink
 *   allowance, not a whole-push budget). Batch import keeps its own
 *   60s-chunk/15s-probe overrides and is NOT migrated here.
 * - NO automatic retries, ever, on this primitive: a timed-out POST may
 *   already have committed server-side, so blind retry can double-write.
 *   One attempt; callers map the timeout like a network error.
 */

export const DEFAULT_SAAS_REQUEST_TIMEOUT_MS = 30_000;
export const SAAS_UPLOAD_TIMEOUT_MS = 120_000;

/** Query keys whose values must never appear in a diagnostic string. */
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "authorization",
  "code",
  "device_code",
  "secret",
]);

/**
 * Redact a request URL for error messages and logs: strip userinfo and
 * fragments, replace sensitive query values, keep host/path for diagnosis.
 * Never throws — an unparseable URL degrades to a fixed placeholder.
 */
export function redactSaasUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return "[unparseable-url]";
  }
}

/**
 * Typed deadline rejection: carries the operation phase, HTTP method,
 * redacted URL and budget so the presentation layer names the failed
 * phase instead of a catch-all "backend is down".
 */
export class SaasRequestTimeoutError extends Error {
  readonly phase: string;
  readonly method: string;
  readonly url: string;
  readonly timeoutMs: number;

  constructor(phase: string, method: string, url: string, timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs} ms during ${phase}: ${method} ${redactSaasUrl(url)}`,
    );
    this.name = "SaasRequestTimeoutError";
    this.phase = phase;
    this.method = method;
    this.url = redactSaasUrl(url);
    this.timeoutMs = timeoutMs;
  }
}

export function isSaasRequestTimeout(err: unknown): err is SaasRequestTimeoutError {
  return err instanceof SaasRequestTimeoutError;
}

/**
 * Body-parse recovery that never swallows a deadline: use as the `catch`
 * callback where code historically tolerated malformed JSON
 * (`.catch(() => ({}))`). Parse errors still fall back; a timeout while
 * the body stalled still wins as a timeout (ticket d13fa9f5).
 */
export function parseFallback<T>(fallback: T): (err: unknown) => T {
  return (err: unknown): T => {
    if (isSaasRequestTimeout(err)) throw err;
    return fallback;
  };
}

export interface FetchWithTimeoutOptions {
  /**
   * Operation phase named in the timeout error — one of the add-path
   * phases (auth / plan-preflight / board-resolution / POST / …) or a
   * subphase in the same vocabulary, e.g. "POST (task-create)".
   */
  phase: string;
  /** Per-call budget; defaults to DEFAULT_SAAS_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

function abortErrorName(err: unknown): string | null {
  if (err instanceof DOMException) return err.name;
  if (err instanceof Error) return err.name;
  return null;
}

/**
 * Drop-in `fetch` with an explicit deadline covering headers AND body.
 *
 * - Aborts the transport at the deadline via AbortController; the timer is
 *   armed during the headers wait and re-armed (for the remaining budget)
 *   around each body read, so a stalled body cannot outlive the deadline.
 * - No timer is left pending between headers and body: after the headers
 *   resolve the timer is disarmed, and each body consumer arms its own for
 *   the time left. Nothing leaks when the caller returns early.
 * - A caller `signal` abort stays a caller abort (the original AbortError
 *   propagates); only OUR deadline raises SaasRequestTimeoutError. No
 *   retries: one attempt, like every existing call site.
 * - The timer is `unref`d so a pending deadline never holds the CLI open.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  opts: FetchWithTimeoutOptions,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SAAS_REQUEST_TIMEOUT_MS;
  const method = (init?.method ?? "GET").toUpperCase();
  const fail = (): SaasRequestTimeoutError =>
    new SaasRequestTimeoutError(opts.phase, method, url, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  const fire = (): void => {
    timedOut = true;
    controller.abort();
  };
  const arm = (): ReturnType<typeof setTimeout> | null => {
    const left = deadline - Date.now();
    if (left <= 0) {
      fire();
      return null;
    }
    const timer = setTimeout(fire, left);
    // SAFETY: Node's setTimeout returns a Timeout with unref; DOM lib
    // types lack it, so probe structurally instead of asserting Node types.
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
    return timer;
  };

  const callerSignal = init?.signal ?? null;
  const onCallerAbort = (): void => {
    controller.abort();
  };
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }
  const disarm = (
    timer: ReturnType<typeof setTimeout> | null,
  ): void => {
    if (timer !== null) clearTimeout(timer);
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  };

  let timer = arm();
  let res: Response;
  try {
    // pi-lens-ignore: ts-ssrf — transport primitive; callers pass
    // getApiUrl()-based URLs or guarded same-origin file URLs only.
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    disarm(timer);
    // Our deadline fired: name the phase. A caller-signal abort (or any
    // other transport failure) propagates untouched — never relabelled.
    if (timedOut && abortErrorName(err) === "AbortError") throw fail();
    throw err;
  }
  disarm(timer);

  // The deadline covers the body too: re-arm for the remaining budget
  // around each body read. An abort that lands mid-body surfaces as the
  // same typed timeout, never as a bare AbortError or a swallowed `{}`.
  const guard = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      if (timedOut) throw fail();
      timer = arm();
      try {
        return await fn(...args);
      } catch (err) {
        if (timedOut && abortErrorName(err) === "AbortError") throw fail();
        throw err;
      } finally {
        disarm(timer);
        timer = null;
      }
    };
  };

  // Lazily wrapped at access time — and only when the method exists: unit
  // fakes (and older runtimes) may carry just ok/status/headers/text/json,
  // and an eager .bind of a missing method would turn every read into a
  // transport failure. A missing method stays missing, exactly as before.
  return new Proxy(res, {
    get(target, prop, _receiver) {
      if (
        prop === "text" ||
        prop === "json" ||
        prop === "arrayBuffer" ||
        prop === "blob"
      ) {
        const original: unknown = Reflect.get(target, prop, target);
        if (typeof original !== "function") return original;
        return guard(original.bind(target));
      }
      return Reflect.get(target, prop, target);
    },
  });
}
