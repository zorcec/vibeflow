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

/**
 * Which API surface a request targets.
 *
 * - `"local"` — the CLI's own board server (same origin / localhost). It
 *   serves the legacy paths (`/api/tasks/*`, `/api/cli/*`) and never had
 *   `/api/v0` writes, so legacy paths must pass through byte-for-byte.
 * - `"cloud"` — the SaaS base returned by `getApiUrl()`. It serves the
 *   unified `/api/v0` contract, so legacy paths map to their v0 equivalent.
 *
 * RULE: this function never guesses the target — every caller passes the
 * mode derived from the address it already uses:
 * - Node cloud paths (`push.ts`, `login.ts`) build URLs from `getApiUrl()`
 *   (always the SaaS base, Bearer-authenticated) → always `"cloud"`.
 * - Browser overlay (`capture.ts`) reads the server-injected `PROTO_CONFIG`:
 *   a `cfg.apiUrl` containing `/api/overlay/tasks` is the SaaS-injected
 *   config (see `getOverlaySaasScript`) → `"cloud"`; the local injected
 *   config (`<origin>/api/tasks`, see `getOverlayScript`) → `"local"`.
 * - Same-origin relative URLs (`baseline-capture.ts`) by construction hit
 *   the serving CLI board, never the cloud → always `"local"`.
 */
export type ApiSurfaceMode = "local" | "cloud";

/**
 * Map a legacy local path to the surface the target serves.
 *
 * `"local"` returns `localPath` unchanged. `"cloud"` returns the `/api/v0`
 * equivalent (`/api/tasks/*` → `/api/v0/tasks/*` with any suffix preserved;
 * `/api/cli/settings` → `/api/v0/settings`; `/api/cli/workspaces` →
 * `/api/v0/boards`; `/api/cli/profile` → `/api/v0/me`; `/api/cli/tasks/*` →
 * `/api/v0/tasks/*`; `/api/cli/auth/*` → `/api/v0/auth/*` (device auth is
 * auth infrastructure that moved under the v0 prefix — it accepts no
 * bearer and is not a resource-contract op). A trailing query string is
 * preserved verbatim.
 * Unmapped paths pass through unchanged (additive safety).
 *
 * `/api/cli/import` has NO v0 equivalent — the contract offers no batch
 * import, so callers must loop `POST /api/v0/tasks` (one per task). Passing
 * it here in `"cloud"` mode throws instead of silently hitting legacy.
 */
export function surfacePath(
  mode: ApiSurfaceMode,
  localPath: string,
): string {
  if (mode === "local") return localPath;
  const q = localPath.indexOf("?");
  const path = q === -1 ? localPath : localPath.slice(0, q);
  const query = q === -1 ? "" : localPath.slice(q);
  if (path === "/api/cli/import" || path.startsWith("/api/cli/import/")) {
    throw new Error(
      "surfacePath: /api/cli/import has no /api/v0 equivalent — loop POST /api/v0/tasks (one per task)",
    );
  }
  const mapped = mapLegacyPathToV0(path);
  return mapped + query;
}

/** Cloud-mode prefix table: first match wins. Kept here — and only here —
 * so no cloud-facing call site scatters its own path strings. */
const V0_PREFIX_TABLE: Array<readonly [string, string]> = [
  ["/api/cli/workspaces", "/api/v0/boards"],
  ["/api/cli/settings", "/api/v0/settings"],
  ["/api/cli/profile", "/api/v0/me"],
  ["/api/cli/auth", "/api/v0/auth"],
  ["/api/cli/tasks", "/api/v0/tasks"],
  ["/api/tasks", "/api/v0/tasks"],
];

function mapLegacyPathToV0(path: string): string {
  for (const [from, to] of V0_PREFIX_TABLE) {
    if (path === from || path.startsWith(from + "/")) {
      return to + path.slice(from.length);
    }
  }
  return path;
}
