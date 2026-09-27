/**
 * Maps a failed SaaS result to the refusal a `--json` consumer earns.
 *
 * Split out of `src/index.ts` so the mapping is a pure function that unit
 * tests can exercise directly — every production path to it needs a live
 * online board, which is exactly the reason the mapping went untested while
 * the code it feeds was documented.
 *
 * Two situations earn two codes, and the split is the whole point:
 *   - an unreachable host is worth retrying;
 *   - a rejected session is not, and repeating the request cannot fix it.
 * SaaS mode is selected BECAUSE a token file exists, so the client's literal
 * `NOT_AUTHENTICATED` (returned when there is no token at all) is the rare
 * case. The realistic failure is an expired or revoked token surfacing as an
 * HTTP 401/403 — which the client reports as `HTTP_ERROR` with `status` set.
 * Keying only on the client's code labelled every one of those
 * `E_BACKEND_UNAVAILABLE`, i.e. "the backend is down, maybe retry".
 */

export interface SaasFailure {
  code: string;
  retryable: boolean;
  suggestion?: string;
}

/** The shape of `SaasResult`'s `error` arm, minus the parts unused here. */
type SaasError = { code: string; status?: number };

export function saasFailure(error: SaasError): SaasFailure {
  const rejected = error.status === 401 || error.status === 403;
  if (error.code === "NOT_AUTHENTICATED" || rejected)
    return {
      code: "E_NOT_AUTHENTICATED",
      retryable: false,
      suggestion: "Run 'vibeflow login' and retry.",
    };
  return {
    code: "E_BACKEND_UNAVAILABLE",
    retryable: error.code === "NETWORK_ERROR",
  };
}
