/**
 * The ONE error envelope for every public API surface (ticket 0045949e,
 * phase 1).
 *
 * `error` is the human sentence a person reads, `code` the machine token a
 * program branches on, `details` the structured hints (expected format,
 * example, offending field). This is exactly what the hosted `/api/v0`
 * routes already answer, so ONE client parses both surfaces without a
 * per-surface translation.
 *
 * Framework-agnostic on purpose: the caller applies `status` to its own
 * response and serializes `body`. `api-core` never imports a server library.
 */
import type { JsonValue } from "./types.js";

/** Structured context folded into `details` — never extra top-level keys. */
export type ApiErrorDetails = Record<string, JsonValue>;

/** A complete refusal: the HTTP status plus the body to serialize with it. */
export interface ApiErrorResponse {
  status: number;
  body: {
    /** Human-readable message — what a UI shows and a log quotes. */
    error: string;
    /** Machine code, e.g. "INVALID_SINCE" — what a client branches on. */
    code: string;
    details?: ApiErrorDetails;
  };
}

/**
 * Build a refusal in the shared envelope.
 *
 * `details` is omitted (not empty) when the caller supplies none, so a plain
 * refusal is byte-identical to the hosted answer for the same refusal.
 */
export function apiError(
  status: number,
  code: string,
  message: string,
  details?: ApiErrorDetails,
): ApiErrorResponse {
  return {
    status,
    body: {
      error: message,
      code,
      ...(details !== undefined ? { details } : {}),
    },
  };
}
