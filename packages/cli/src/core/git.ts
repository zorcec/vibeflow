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
import { findTaskFilePath, readTaskFile, updateTask } from "./tasks.js";

export function commitTaskChanges(
  projectDir: string,
  taskId: string,
  message: string,
): { ok: true; sha: string } | { ok: false; error: string } {
  try {
    const commitMsg = `${message} [proto:${taskId}]`;
    execFileSync("git", ["commit", "-m", commitMsg], {
      cwd: projectDir,
      stdio: "inherit",
    });
    const sha = execSync("git rev-parse HEAD", { cwd: projectDir })
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
