/**
 * Feature flags (ticket 0847833f follow-up): ONE env var gates every
 * opt-in surface — `VIBEFLOW_FEATURES=CHAT` today, comma- or
 * space-separated lists tomorrow (`VIBEFLOW_FEATURES=CHAT,FOO BAR`).
 *
 * WHAT: parse + case-insensitive membership test. A dedicated flag env
 * var per feature does not scale (each one needs discovery, docs, and
 * tests); a single list keeps the surface to one variable with one
 * grammar. Names are matched case-insensitively (`chat`, `Chat`,
 * `CHAT` all enable) so shell/copypaste casing never silently disables
 * a feature.
 *
 * Grammar: split on commas and/or whitespace, drop empties.
 * `""` / unset / `"  , "` → no flags (everything default-OFF).
 */
export const FEATURE_FLAGS_ENV_VAR = "VIBEFLOW_FEATURES";

/** Parse the raw env value into normalized (upper-case) flag names. */
export function parseFeatureFlags(
  raw: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const value = raw !== undefined ? raw : env[FEATURE_FLAGS_ENV_VAR];
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
}

/** True when the named feature flag is present (case-insensitive). */
export function isFeatureEnabled(
  name: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return parseFeatureFlags(undefined, env).includes(name.trim().toUpperCase());
}

/** Feature names known today (registry so `--help`/docs can list them). */
export const KNOWN_FEATURES = ["CHAT"] as const;
export type KnownFeature = (typeof KNOWN_FEATURES)[number];

/** Agent chat feature name (ticket 0847833f). */
export const CHAT_FEATURE = "CHAT";
