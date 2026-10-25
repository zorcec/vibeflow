/**
 * Isolated CLI spawn helper (ticket 8ac96ef9).
 *
 * Every spawn of the CLI is a credential-touching operation: the binary
 * resolves its token, workspace, machine id, and global settings from
 * `os.homedir()/.vibeflow` at load time, merges the owner-global
 * `~/.vibeflow/settings.json` into every project, aims its SaaS client at
 * `$VIBEFLOW_API_URL`, and lets `$VIBEFLOW_PROJECT_DIR` redirect the project
 * root. A child spawned without an explicit env inherits the operator's real
 * HOME — the same class that once destroyed the operator's auth token when a
 * `vibeflow serve` spawn's logout path deleted `~/.vibeflow/token`.
 *
 * This module is the single mechanical chokepoint for that env. Every test
 * that spawns the CLI (vitest e2e/playwright, scripts) MUST build the child
 * env through {@link isolatedCliEnv} (directly, or via `spawnCliIsolated` /
 * `runCliIsolatedSync` / the `mcp-helpers.ts` wrappers, which delegate here).
 * `tests/unit/cli-spawn-guard.test.ts` scans the suite for raw CLI spawns
 * that bypass this module and fails, so the next spawn site cannot be added
 * without isolation.
 *
 * What the env guarantees:
 * - `HOME` is ALWAYS the caller-supplied temp dir — never inherited. All CLI
 *   persistent state (token, workspace, settings, machine id, telemetry
 *   cache) derives from `os.homedir()`, so isolating HOME isolates state.
 * - `VIBEFLOW_TELEMETRY` is forced to `"0"`.
 * - `GIT_*` is never inherited. Git exports repo-location and identity
 *   variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_AUTHOR_*`, …) into hooks,
 *   and an inherited one makes the child's git ignore its cwd and operate
 *   on the OUTER repository.
 * - `GIT_CEILING_DIRECTORIES` pins discovery at the spawn cwd (and tmpdir),
 *   so the child's git can never escape upward into the real checkout.
 * - Redirects are never inherited: `VIBEFLOW_API_URL` (SaaS backend),
 *   `VIBEFLOW_PROJECT_DIR` (project root), and the introspection guards
 *   `VIBEFLOW_CLI_SKIP_PARSE` / `VIBEFLOW_CLI_SKIP_REFRESH` (which would make
 *   the child a silent no-op) are dropped unless the caller passes them
 *   explicitly per-run via `opts.env`.
 *
 * Callers own their temp dirs (create with `mkdtemp`, remove in
 * `afterEach`/`afterAll`) and pass them as `opts.home` — the helper never
 * invents a HOME it cannot clean up.
 */

import { spawn, execFileSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** The CLI under test. `VIBEFLOW_E2E_CLI` points the suite at a different
 * build (coverage runs); otherwise the shipped `dist/index.js`, anchored at
 * the module location — never `process.cwd()`, whose value depends on where
 * the invoker stands. */
export const CLI_ENTRY =
  process.env.VIBEFLOW_E2E_CLI ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");

/**
 * Env vars that redirect the child at a different backend / project, or turn
 * it into a silent no-op. Never inherited — only honoured when the caller
 * passes them explicitly in `opts.env` for that run (e.g. `VIBEFLOW_API_URL`
 * aiming the SaaS client at a stub).
 */
const REDIRECT_VARS = [
  "VIBEFLOW_API_URL",
  "VIBEFLOW_PROJECT_DIR",
  "VIBEFLOW_CLI_SKIP_PARSE",
  "VIBEFLOW_CLI_SKIP_REFRESH",
] as const;

export interface IsolatedCliEnvOptions {
  /** Caller-owned temp dir — becomes the child's HOME. */
  home: string;
  /** Spawn cwd. Also seeds GIT_CEILING_DIRECTORIES. */
  cwd?: string;
  /** Extra per-run vars. Wins over every default (including redirects). */
  env?: Record<string, string>;
}

/**
 * Build the child env: `process.env` minus everything that could aim the
 * CLI at the operator's state, plus the isolation pins. Pure (reads
 * `process.env`, writes nothing) so tests can assert on it without spawning.
 */
export function isolatedCliEnv(opts: IsolatedCliEnvOptions): NodeJS.ProcessEnv {
  const { home, cwd, env: extra = {} } = opts;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "HOME") continue; // always replaced below, never inherited
    if (key.startsWith("GIT_")) continue;
    if (
      (REDIRECT_VARS as readonly string[]).includes(key) &&
      !(key in extra)
    )
      continue;
    env[key] = value;
  }
  env.HOME = home;
  env.VIBEFLOW_TELEMETRY = "0";
  env.GIT_CEILING_DIRECTORIES = cwd
    ? `${cwd}${delimiter}${tmpdir()}`
    : tmpdir();
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

export interface SpawnCliOptions {
  cwd: string;
  /** Caller-owned temp dir — becomes the child's HOME. */
  home: string;
  timeoutMs?: number;
  /** Extra per-run vars (e.g. VIBEFLOW_API_URL to aim the SaaS client). */
  env?: Record<string, string>;
}

export interface SpawnCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  elapsedMs: number;
}

/**
 * Spawn the isolated CLI (async, pipe-captured). Resolves on exit — never
 * rejects on non-zero (assert on `code`), SIGKILLs on deadline.
 */
export function spawnCliIsolated(
  args: string[],
  opts: SpawnCliOptions,
): Promise<SpawnCliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: opts.cwd,
      env: isolatedCliEnv(opts),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const start = Date.now();
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      opts.timeoutMs ?? 15_000,
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, elapsedMs: Date.now() - start });
    });
  });
}

/**
 * Run the isolated CLI synchronously, returning stdout. Throws on non-zero
 * exit (the thrown error carries `.stdout`, `.stderr`, `.status`, like
 * `execFileSync`) — for tests that assert failure with try/catch.
 */
export function runCliIsolatedSync(
  args: string[],
  opts: { cwd: string; home: string; env?: Record<string, string> },
): string {
  return execFileSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    env: isolatedCliEnv(opts),
    encoding: "utf-8",
  });
}
