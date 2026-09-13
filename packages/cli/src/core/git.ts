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

    // Read current task to get existing commits
    const existingCommits = readTaskFile(filePath)?.commits ?? [];

    // Append commit record — updateTask handles its own locking.
    updateTask(projectDir, taskId, {
      commits: [
        ...existingCommits,
        { sha, message, timestamp: new Date().toISOString() },
      ],
    });

    return { ok: true, sha };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
