/**
 * Hermetic `git` for tests that need a real repository.
 *
 * Several suites create a scratch repo in a tmpdir and shell out to real `git`
 * in order to exercise the auto-commit paths for real. That works — until the
 * test suite itself is run FROM a git operation, because git exports a set of
 * `GIT_*` variables into every hook and child process:
 *
 *     GIT_INDEX_FILE, GIT_DIR, GIT_WORK_TREE, GIT_AUTHOR_*, GIT_COMMITTER_*
 *
 * Those variables OVERRIDE the repository the command would otherwise pick up
 * from `cwd`. A `git add` in a brand-new tmpdir repo then stages into the
 * OUTER repository's index, and `git diff --cached` fails outright. The symptom
 * is a test that passes on a bare `vitest run` and fails inside the husky
 * pre-commit hook — which is exactly how
 * `tests/unit/mcp/success-payload-committed.test.ts` failed:
 *
 *     FAIL  a SUCCESSFUL auto-commit (GIT_COMMITTED) gets no committed key
 *     AssertionError: expected 'Command failed: git diff --cached --n…'
 *
 * Stripping the inherited variables makes the scratch repo authoritative, so the
 * test behaves identically whether it is run directly, under the hook, or inside
 * any other git-driven wrapper.
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

/**
 * Every `GIT_*` variable in `process.env`, removed.
 *
 * Exported so tests can pass `env: hermeticGitEnv()` to their own spawn calls
 * when they need other options alongside it.
 */
export function hermeticGitEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

/** `execFileSync("git", …)` against a scratch repo, immune to ambient GIT_*. */
export function git(
  args: string[],
  cwd: string,
  options: Omit<ExecFileSyncOptionsWithStringEncoding, "cwd" | "env"> = {},
): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    ...options,
    env: hermeticGitEnv(),
  });
}