/**
 * Principal abstraction for the /api/v1 contract (plan §4.3).
 *
 * One resolver, one shape — route code never branches on environment:
 * the local side resolves the trusted principal (today's localhost trust
 * model expressed as a scope grant, never a token surface) and the cloud
 * side resolves a user principal from a bearer token (P2; the header
 * parsers below are the shared seam it builds on).
 */

import { ALL_SCOPES, type ScopeName } from "./scope.js";

/**
 * What a request acts within. Local = the single implicit project the
 * server is bound to; board = one cloud board (X-Vibeflow-Scope, §3.3).
 */
export type ScopeRef =
  | { kind: "local" }
  | { kind: "board"; boardId: string; workspaceId?: string };

export interface Principal {
  kind: "local" | "user";
  userId?: string;
  /** Local: ALL_SCOPES; user: derived from the token (P2). */
  scopes: ReadonlySet<ScopeName>;
  scope: ScopeRef;
  tokenId?: string;
}

/**
 * The local trusted principal (plan §4.3): localhost trust expressed as a
 * `local` scope with every grant. No token is read, issued, or accepted —
 * inventing auth for the local side is explicitly out of scope (P1).
 */
export function resolveLocalPrincipal(): Principal {
  return { kind: "local", scopes: ALL_SCOPES, scope: { kind: "local" } };
}

/**
 * Extract a bearer secret from an Authorization header value. Pure parsing
 * only — validation against a token table is the cloud adapter's job (P2).
 * Returns null when no bearer credential is presented.
 */
export function extractBearerToken(
  authorization: string | undefined | null,
): string | null {
  if (typeof authorization !== "string") return null;
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return null;
  const secret = authorization.slice(prefix.length).trim();
  return secret.length > 0 ? secret : null;
}

/** 400 raised for a malformed X-Vibeflow-Scope value. */
export class ScopeHeaderError extends Error {
  readonly status = 400;
  readonly code = "INVALID_SCOPE";
  constructor(detail: string) {
    super(`invalid X-Vibeflow-Scope: ${detail}`);
    this.name = "ScopeHeaderError";
  }
}

/**
 * Parse an X-Vibeflow-Scope header value into a ScopeRef (plan §3.3/D4).
 * Absent/empty = the implicit local project; otherwise a board id
 * (non-empty, no whitespace or control characters). The cloud's
 * single-board default vs 422 SCOPE_REQUIRED rule needs membership context
 * and lives in the cloud adapter — this parser only validates the shape.
 */
export function parseScopeHeaderValue(
  value: string | undefined | null,
): ScopeRef {
  if (value === undefined || value === null || value.trim() === "") {
    return { kind: "local" };
  }
  const boardId = value.trim();
  if (/[\s\x00-\x1f\x7f]/.test(boardId) || boardId.length > 256) {
    throw new ScopeHeaderError("must be a single board id");
  }
  return { kind: "board", boardId };
}
