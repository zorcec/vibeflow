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
import { gitEnvWithCleanLocation } from "./git-env.js";
import { findTaskFilePath, readTaskFile, updateTask } from "./tasks.js";

export function commitTaskChanges(
  projectDir: string,
  taskId: string,
  message: string,
): { ok: true; sha: string } | { ok: false; error: string } {
  try {
    const commitMsg = `${message} [proto:${taskId}]`;
    // Commit into `projectDir`'s repo even when a GIT_DIR/GIT_WORK_TREE leaked
    // from an enclosing hook (e.g. the pre-commit hook running the test suite).
    const env = gitEnvWithCleanLocation();
    execFileSync("git", ["commit", "-m", commitMsg], {
      cwd: projectDir,
      env,
      stdio: "inherit",
    });
    const sha = execSync("git rev-parse HEAD", { cwd: projectDir, env })
      .toString()
      .trim();

    // Read current task to get existing commits
    const filePath = findTaskFilePath(projectDir, taskId);
    const existingCommits = filePath
      ? (readTaskFile(filePath)?.commits ?? [])
      : [];

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
