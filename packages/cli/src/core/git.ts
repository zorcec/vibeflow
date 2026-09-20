/**
 * Shared git commit helper.
 *
 * Used by CLI commit mode, CLI edit-mode auto-commit, and MCP update_task
 * to ensure identical commit logic across all three surfaces.
 *
 * Convention: commit message is tagged with [proto:<taskId>] and the commit
 * record (sha + message + timestamp) is appended to the task's `commits` array.
 */
import { execFileSync, execSync } from "node:child_process";
import { relative } from "node:path";
import { gitEnvWithCleanLocation } from "./git-env.js";
import { findTaskFilePath, readTaskFile, updateTask } from "./tasks.js";
import { getFilesDir } from "./files.js";

/** Appends a commit record (sha + message + timestamp) to the task's `commits` array. */
function appendCommitRecord(
  projectDir: string,
  filePath: string,
  taskId: string,
  message: string,
  sha: string,
): void {
  const existingCommits = readTaskFile(filePath)?.commits ?? [];
  updateTask(projectDir, taskId, {
    commits: [
      ...existingCommits,
      { sha, message, timestamp: new Date().toISOString() },
    ],
  });
}

/**
 * Commits the task's own file and its attachment directory, and nothing else.
 *
 * Every lane shares one git index in one working tree, so a plain `git commit`
 * commits whatever ANY lane has staged — sweeping another lane's files into this
 * task's commit and misattributing them (this is how a foreign deletion once got
 * swept into an unrelated commit). A pathspec-limited commit can only ever
 * include this task's file plus files under its own attachments directory.
 */
export function commitTaskChanges(
  projectDir: string,
  taskId: string,
  message: string,
): { ok: true; sha: string } | { ok: false; error: string } {
  try {
    const commitMsg = `${message} [proto:${taskId}]`;

    const filePath = findTaskFilePath(projectDir, taskId);
    if (!filePath) {
      return { ok: false, error: `Task file not found: ${taskId}` };
    }
    const relTaskPath = relative(projectDir, filePath);
    const relFilesDir = relative(projectDir, getFilesDir(projectDir, taskId));

    // Only staged paths that belong to THIS task are eligible. `git diff
    // --cached --name-only` lists staged paths relative to the repo root, which
    // is `projectDir`; paths that another lane staged are left untouched in the
    // index and stay staged for their own owner to commit.
    const staged = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd: projectDir,
      env: gitEnvWithCleanLocation(),
    })
      .toString()
      .split("\0")
      .filter(Boolean);
    const scoped = staged.filter(
      (p) =>
        p === relTaskPath ||
        p === relFilesDir ||
        p.startsWith(`${relFilesDir}/`),
    );
    if (scoped.length === 0) {
      return {
        ok: false,
        error: `No staged changes for task ${taskId}. Stage the task file first: git add ${relTaskPath}`,
      };
    }

    // Commit into `projectDir`'s repo even when a GIT_DIR/GIT_WORK_TREE leaked
    // from an enclosing hook (e.g. the pre-commit hook running the test suite).
    const env = gitEnvWithCleanLocation();
    execFileSync("git", ["commit", "-m", commitMsg, "--", ...scoped], {
      cwd: projectDir,
      env,
      stdio: "inherit",
    });
    const sha = execSync("git rev-parse HEAD", { cwd: projectDir, env })
      .toString()
      .trim();

    // Append commit record — updateTask handles its own locking.
    appendCommitRecord(projectDir, filePath, taskId, message, sha);

    return { ok: true, sha };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Result of a path-scoped task commit (see {@link commitTaskPaths}). */
export type TaskCommitResult =
  | {
      ok: true;
      sha: string;
      /**
       * True when there was nothing to commit, so the current HEAD was linked to
       * the task instead of creating a commit. `sha` is that existing HEAD.
       */
      linkedExisting: boolean;
      /** Repo-relative paths included in the commit (empty when linking HEAD). */
      committed: string[];
      /**
       * Staged paths outside this task's scope that were left in the index for
       * their own owner. Only populated when no explicit pathspec was given.
       */
      foreign: string[];
    }
  | { ok: false; error: string };

/**
 * Commits for a task, limited to an optional pathspec, and never dead-ends.
 *
 * - With explicit `paths`, exactly those paths are committed (git's own pathspec
 *   form); every other staged path is left in the index for its owner.
 * - With no paths, the scope is the task's own record — its JSON file and
 *   attachment directory — the same scoping as {@link commitTaskChanges}.
 * - When there is nothing to commit the current HEAD is linked to the task
 *   instead of failing: the caller's intent is "record that this task's work is
 *   in commit X", and when the work is already committed, X is HEAD. This is
 *   the case that used to leave a task with no commit link after a clean tree.
 *
 * Unlike {@link commitTaskChanges}, this helper never requires the caller to
 * stage anything, so a bare `git commit` is never needed and the shared index is
 * never swept.
 */
export function commitTaskPaths(
  projectDir: string,
  taskId: string,
  message: string,
  paths: string[] = [],
): TaskCommitResult {
  try {
    const env = gitEnvWithCleanLocation();
    const commitMsg = `${message} [proto:${taskId}]`;

    const filePath = findTaskFilePath(projectDir, taskId);
    if (!filePath) {
      return { ok: false, error: `Task file not found: ${taskId}` };
    }
    const relTaskPath = relative(projectDir, filePath);
    const relFilesDir = relative(projectDir, getFilesDir(projectDir, taskId));
    const belongsToTask = (p: string): boolean =>
      p === relTaskPath ||
      p === relFilesDir ||
      p.startsWith(`${relFilesDir}/`);

    const staged = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      { cwd: projectDir, env },
    )
      .toString()
      .split("\0")
      .filter(Boolean);

    // Explicit paths win: they are exactly what the caller asked to commit. With
    // no pathspec, scope to this task's own record and keep the rest of the
    // index intact for whichever lane staged it.
    const explicit = paths.length > 0;
    const scoped = explicit ? paths : staged.filter(belongsToTask);
    const foreign = explicit ? [] : staged.filter((p) => !belongsToTask(p));

    // `git commit -- <paths>` records the working-tree content of those paths, so
    // any change (staged, unstaged, or untracked) counts. Without a pathspec the
    // task's own record must be staged, matching commitTaskChanges.
    const hasChanges = explicit
      ? execFileSync(
          "git",
          ["status", "--porcelain", "-z", "--", ...scoped],
          { cwd: projectDir, env },
        )
          .toString()
          .split("\0")
          .filter(Boolean).length > 0
      : scoped.length > 0;

    if (!hasChanges) {
      const sha = execSync("git rev-parse HEAD", { cwd: projectDir, env })
        .toString()
        .trim();
      appendCommitRecord(projectDir, filePath, taskId, message, sha);
      return { ok: true, sha, linkedExisting: true, committed: [], foreign };
    }

    // Never a bare `git commit`: the pathspec keeps another lane's staged work
    // in the index.
    execFileSync("git", ["commit", "-m", commitMsg, "--", ...scoped], {
      cwd: projectDir,
      env,
      stdio: "inherit",
    });
    const sha = execSync("git rev-parse HEAD", { cwd: projectDir, env })
      .toString()
      .trim();
    appendCommitRecord(projectDir, filePath, taskId, message, sha);
    return { ok: true, sha, linkedExisting: false, committed: scoped, foreign };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
