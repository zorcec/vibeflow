/**
 * CLI version, shared by anything that must advertise it.
 *
 * `__VIBEFLOW_CLI_VERSION__` is injected at build time by tsup
 * (tsup.cli.config.ts) from packages/cli/package.json — the only JS bundle
 * for the CLI. Vitest mirrors that define (vitest.e2e.config.ts) because the
 * e2e harness boots the MCP server in-process from src/. A raw-TS run with
 * no define falls back to "0.0.0".
 *
 * Reading package.json at runtime was rejected: src/ and dist/ sit at
 * different depths, so one relative path cannot be right in both.
 */
declare const __VIBEFLOW_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __VIBEFLOW_CLI_VERSION__ === "undefined"
    ? "0.0.0"
    : __VIBEFLOW_CLI_VERSION__;
