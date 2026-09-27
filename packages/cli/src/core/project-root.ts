/**
 * Project root resolution and validation (model1-mcp plan §W1).
 *
 * The root is resolved exactly once, at server start; every tool call uses
 * that one root. Two boundaries, deliberately split:
 *
 * - `resolveProjectRoot` runs at the **CLI boundary**, where a human starts
 *   `serve`/`kanban`. It enforces the full rule: an existing directory that
 *   is not `/`, not `$HOME`, and is either a git repo or a vibeflow store
 *   (contains `.vibeflow/`). Nothing is created before it passes.
 * - `assertSafeProjectDir` is the **server-layer backstop**, called inside
 *   `serve()` before `ensureTaskDirs()` writes anything. It refuses only the
 *   two irreversible cases (`/` and `$HOME`). The full rule cannot live here:
 *   unit and Playwright tests call `serve()` directly on bare temp dirs, and
 *   seeding `.vibeflow/` into those fixtures is the wrong direction.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { getCurrentBranch, getProjectName } from "./config.js";

export type ProjectRootResult =
  | { ok: true; projectDir: string; name: string; branch: string | null }
  | { ok: false; code: string; message: string; suggestion: string };

  /** Suggestion shared by every refusal — the flag a human must pass instead. */
  const PROJECT_FLAG_HINT =
    "Pass --project <dir> to a git repository, or to a directory that already contains .vibeflow/.";

  /**
   * Added when the directory *could* hold a store but has none yet. `--project`
   * alone is a dead end for someone who wants to start working here, so name
   * the command that actually creates `.vibeflow/` (verified: `tasks --add`
   * creates the store in cwd).
   */
  const PROJECT_INIT_HINT =
    'To start a project here, run `vibeflow tasks --add --title "first task"` — that creates the .vibeflow/ store — or `git init` to make this directory a repository.';

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function validate(abs: string): ProjectRootResult {
  if (!isDirectory(abs)) {
    return {
      ok: false,
      code: "PROJECT_ROOT_NOT_FOUND",
      message: `Project root not found: ${abs} is not an existing directory.`,
      suggestion: `Create it, or pass --project <dir> pointing at an existing directory.`,
    };
  }
  if (abs === parse(abs).root) {
    return {
      ok: false,
      code: "PROJECT_ROOT_IS_FILESYSTEM_ROOT",
      message: `${abs} is the filesystem root — refusing to use it as a project root.`,
      suggestion: PROJECT_FLAG_HINT,
    };
  }
  if (abs === homedir()) {
    return {
      ok: false,
      code: "PROJECT_ROOT_IS_HOME",
      message: `${abs} is your home directory — refusing to use it as a project root.`,
      suggestion: PROJECT_FLAG_HINT,
    };
  }
  const isGitRepo = existsSync(resolve(abs, ".git"));
  const isStore = existsSync(resolve(abs, ".vibeflow"));
  if (!isGitRepo && !isStore) {
    return {
      ok: false,
      code: "PROJECT_ROOT_NOT_A_PROJECT",
      message: `${abs} is not a vibeflow project: no .git and no .vibeflow/.`,
      suggestion: `${PROJECT_FLAG_HINT} ${PROJECT_INIT_HINT}`,
    };
  }
  return {
    ok: true,
    projectDir: abs,
    name: getProjectName(abs),
    branch: getCurrentBranch(abs),
  };
}

/**
 * Resolves and validates the project root once, at startup.
 *
 * `mode: "http"` — a human started `serve`/`kanban`: an omitted dir defaults
 * to `process.cwd()`. `mode: "stdio"` — an MCP client spawned the server: cwd
 * belongs to the client (often the user's home), so it is never trusted and a
 * missing `--project` is a hard refusal.
 */
export function resolveProjectRoot(
  rawDir: string | undefined,
  opts: { mode: "http" | "stdio" },
): ProjectRootResult {
  if (rawDir === undefined) {
    if (opts.mode === "stdio") {
      return {
        ok: false,
        code: "PROJECT_ROOT_REQUIRED",
        message: "--project <dir> is required when the MCP client spawns the server",
        suggestion:
          'Add "args": ["mcp", "--project", "."] to the server entry in .mcp.json.',
      };
    }
    return validate(resolve(process.cwd()));
  }
  return validate(resolve(rawDir));
}

/**
 * Defence in depth for programmatic callers: throws before `ensureTaskDirs`
 * could create a task store in a directory that must never hold one.
 * The full git/`.vibeflow` rule stays at the CLI boundary (see header).
 */
export function assertSafeProjectDir(dir: string): void {
  const abs = resolve(dir);
  if (abs === parse(abs).root) {
    throw new Error(
      `Refusing to create a task store at the filesystem root (${abs}).`,
    );
  }
  if (abs === homedir()) {
    throw new Error(
      `Refusing to create a task store in your home directory (${abs}).`,
    );
  }
}

/**
 * The startup line printed (stdout) before anything is written, so a human
 * always sees which directory was chosen and why.
 */
export function formatProjectRootAnnouncement(root: {
  projectDir: string;
  name: string;
  branch: string | null;
}): string {
  return `✓ Project root: ${root.projectDir} (${root.name}, branch ${root.branch ?? "none"})`;
}
