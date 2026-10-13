/**
 * Personal access token (PAT) shared primitives (plan §4.2, P2).
 *
 * Pure string helpers only — no node:crypto import, so api-core stays
 * dependency-free like the rest of this package. Hashing (sha256 of the
 * secret) and persistence live on the server side: the secret is 256-bit
 * random, so a fast hash is the documented choice and the digest
 * comparison belongs next to the token table, not here.
 *
 * Format: `vbf_pat_<prefix 8 hex>_<secret 43 base64url>` — the prefix is
 * shown in the UI and indexed for lookup; the full secret is hashed and
 * compared, never stored or logged.
 */

import { SCOPE_NAMES, isScopeName, type ScopeName } from "./scope.js";

/** Scheme prefix every PAT secret starts with. */
export const PAT_SCHEME_PREFIX = "vbf_pat_";

/** Hex characters of the display/lookup prefix (8 chars = 32 bits). */
export const PAT_PREFIX_CHARS = 8;

/** Base64url characters of the random secret part (32 bytes, unpadded). */
export const PAT_SECRET_CHARS = 43;

/** A successfully parsed PAT secret: lookup prefix + random part. */
export interface ParsedPat {
  prefix: string;
  secretPart: string;
}

const PAT_PREFIX_RE = /^[0-9a-f]{8}$/;
const PAT_SECRET_RE = /^[A-Za-z0-9_\-]{43}$/;

/**
 * Split a presented secret into its lookup prefix and secret part.
 * Returns null for anything that is not exactly one `vbf_pat_` secret —
 * callers treat null as "not a PAT" (401), never as an error to detail.
 *
 * The secret part is base64url, whose alphabet contains `_`, so the split
 * is positional, not separator-based: 8 hex chars, one `_`, 43 secret
 * chars, end of string.
 */
export function parsePatSecret(secret: unknown): ParsedPat | null {
  if (typeof secret !== "string") return null;
  if (!secret.startsWith(PAT_SCHEME_PREFIX)) return null;
  const rest = secret.slice(PAT_SCHEME_PREFIX.length);
  if (rest.length !== PAT_PREFIX_CHARS + 1 + PAT_SECRET_CHARS) return null;
  const prefix = rest.slice(0, PAT_PREFIX_CHARS);
  const sep = rest.charAt(PAT_PREFIX_CHARS);
  const secretPart = rest.slice(PAT_PREFIX_CHARS + 1);
  if (sep !== "_") return null;
  if (!PAT_PREFIX_RE.test(prefix)) return null;
  if (!PAT_SECRET_RE.test(secretPart)) return null;
  return { prefix, secretPart };
}

/** True when the value is exactly one well-formed PAT secret. */
export function isPatFormat(secret: unknown): secret is string {
  return parsePatSecret(secret) !== null;
}

/**
 * The lookup prefix of a presented secret, or null when malformed.
 * The server looks up candidates by this prefix, then hashes and compares
 * the full secret — the prefix alone never authenticates.
 */
export function extractPatPrefix(secret: unknown): string | null {
  const parsed = parsePatSecret(secret);
  return parsed ? parsed.prefix : null;
}

/**
 * Assemble a secret from separately generated parts. The single
 * construction site is the server-side minter; every other module parses.
 */
export function formatPatSecret(prefix: string, secretPart: string): string {
  if (!PAT_PREFIX_RE.test(prefix)) {
    throw new Error("formatPatSecret: prefix must be 8 hex chars");
  }
  if (!PAT_SECRET_RE.test(secretPart)) {
    throw new Error("formatPatSecret: secret part must be 43 base64url chars");
  }
  return `${PAT_SCHEME_PREFIX}${prefix}_${secretPart}`;
}

/**
 * "Read only" access preset for the Settings create dialog (plan §4.5):
 * every read scope, never a write, never token management.
 */
export const PAT_READ_ONLY_SCOPES: readonly ScopeName[] = [
  "tasks:read",
  "boards:read",
  "comments:read",
  "files:read",
  "settings:read",
  "profile:read",
];

/**
 * "Read & write" access preset (plan §4.2 "Full access"): every
 * resource scope except `tokens:manage`, which is never granted by
 * default — a token that can mint tokens is a separate, explicit act.
 */
export const PAT_READ_WRITE_SCOPES: readonly ScopeName[] = [
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
];

/**
 * Validate + dedupe a requested scope set into contract order
 * (SCOPE_NAMES). Unknown names are dropped (the route layer rejects the
 * request when nothing valid remains); `tokens:manage` passes through
 * here — whether it may be granted is the route's decision, not the
 * parser's.
 */
export function normalizeTokenScopes(input: unknown): ScopeName[] {
  if (!Array.isArray(input)) return [];
  const wanted = new Set<ScopeName>();
  for (const entry of input) {
    if (isScopeName(entry)) wanted.add(entry);
  }
  return SCOPE_NAMES.filter((name) => wanted.has(name));
}
