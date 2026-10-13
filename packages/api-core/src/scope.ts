/**
 * Scope vocabulary for the /api/v1 contract (plan §1.2 table, §4.2/§4.3).
 *
 * Scopes are resource-level, namespaced `resource:action`. Every v1
 * operation declares one in the contract (`scope` on each registry entry);
 * `requireScope` is the single gate both surfaces call before serving.
 */

import type { Principal } from "./principal.js";

/** Every scope name the contract may reference (plan §1.2 + §4.2). */
export const SCOPE_NAMES = [
  "tasks:read",
  "tasks:write",
  "boards:read",
  "boards:write",
  "comments:read",
  "comments:write",
  "files:read",
  "files:write",
  "settings:read",
  "settings:write",
  "profile:read",
  "tokens:manage",
] as const;

export type ScopeName = (typeof SCOPE_NAMES)[number];

/** True when the value is a gateable scope name. */
export function isScopeName(value: unknown): value is ScopeName {
  return (
    typeof value === "string" &&
    (SCOPE_NAMES as readonly string[]).includes(value)
  );
}

/** All scopes — the local trusted principal's grant (plan §4.3). */
export const ALL_SCOPES: ReadonlySet<ScopeName> = new Set(SCOPE_NAMES);

/** 403 raised by requireScope. Carries the missing scope for the response. */
export class ScopeDeniedError extends Error {
  /** HTTP status for the denial (always 403 — authenticated, not permitted). */
  readonly status = 403;
  /** Machine code for the contract error shape ({ error, code }). */
  readonly code = "SCOPE_DENIED";
  readonly required: ScopeName;

  constructor(required: ScopeName) {
    super(`missing required scope: ${required}`);
    this.name = "ScopeDeniedError";
    this.required = required;
  }
}

/**
 * The single scope gate (plan §4.3). Throws ScopeDeniedError (403) when the
 * principal lacks `scope`; a null scope (public read) always passes.
 */
export function requireScope(
  principal: Pick<Principal, "scopes">,
  /** One ScopeName, or null for public reads (the changelog). */
  scope: ScopeName | null,
): void {
  if (scope === null) return;
  if (!isScopeName(scope)) {
    throw new Error(`unknown scope in contract: ${JSON.stringify(scope)}`);
  }
  if (!principal.scopes.has(scope)) {
    throw new ScopeDeniedError(scope);
  }
}
