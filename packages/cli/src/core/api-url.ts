/**
 * Single source of truth for the production API host.
 *
 * The CLI previously defaulted to a hostname that is served by nothing
 * (in five separate places) — login and push could not connect for
 * anyone. The production app lives at `https://freemium.vibeflow.tools`,
 * so that is the default here.
 *
 * `VIBEFLOW_API_URL` still overrides the default (local dev, stage, tests) —
 * it is the seam a future host picker will use. Values that are not
 * well-formed http(s) URLs fall back to the production default so a Bearer
 * token can never be sent to a file:// or malformed host
 * (SSRF/credential-leak guard, moved here verbatim from saas/client.ts).
 */

// Stryker disable once StringLiteral: default API URL is a configuration constant
export const DEFAULT_API_URL = "https://freemium.vibeflow.tools";

/**
 * Resolve the API base URL from the environment. Validates that the value
 * is a well-formed http(s) URL and falls back to the production default for
 * anything else — Bearer tokens must never be sent to file://, custom schemes,
 * or malformed hosts (SSRF/credential-leak guard). Also guarantees callers'
 * `new URL(...)` never throws on a bad env value.
 */
export function getApiUrl(): string {
  const raw = process.env.VIBEFLOW_API_URL ?? DEFAULT_API_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:")
      return DEFAULT_API_URL;
    return raw.replace(/\/+$/, "");
  } catch {
    return DEFAULT_API_URL;
  }
}
