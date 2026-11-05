/**
 * Shipped default hooks — read IN PLACE from the installed package
 * (ADR-0006 superseded by ADR-0007 — the `~/.vibeflow/hooks/defaults/`
 * materialisation copy is gone, never migrated, never cleaned up by code).
 *
 * The files live in `src/core/hooks/defaults/` (committed source,
 * written by `scripts/gen-hook-defaults.mjs`) and ship as
 * `<pkg>/dist/hooks/defaults/` (`package.json` `files` lists
 * `"dist/hooks/"` explicitly — `dist/*.js` does not cover `.mjs`). The
 * lookup root is DERIVED from the running bundle
 * (`resolveShippedDefaultsDir`), never configured, so npm nested
 * installs, pnpm symlink-into-store, npx cache, global install and
 * tarball all resolve without any path allowlist. Upgrade rule: `npm`
 * (or `pnpm`) `update` replaces the package, which replaces the
 * defaults — no copy, no version marker in `$HOME`, no second source of
 * truth.
 */
export { resolveShippedDefaultsDir } from "./discover.js";
export { SHIPPED_DEFAULTS_VERSION } from "./defaults.generated.js";
