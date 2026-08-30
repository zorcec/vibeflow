import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PROTO_DIR, FILES_DIR } from "./types.js";
import { listTasks } from "./tasks.js";

/**
 * Verification evidence files are named `verify-*.json` and stored in the
 * task's files directory (`.vibeflow/tasks/files/<taskId>/`).
 *
 * The presence of at least one such file indicates that `vibeflow verify <id>`
 * has been run successfully and produced evidence artifacts.
 */
// Stryker disable next-line StringLiteral: structural constant for file pattern matching
const VERIFY_EVIDENCE_PREFIX = "verify-";
// Stryker disable next-line StringLiteral: structural constant for file pattern matching
const VERIFY_EVIDENCE_SUFFIX = ".json";

/**
 * Checks whether a task has verification evidence attached.
 *
 * Verification evidence = any file matching `verify-*.json` in the task's
 * files directory (`.vibeflow/tasks/files/<taskId>/`).
 *
 * @returns `{ allowed: true }` when evidence exists, or
 *   `{ allowed: false, reason: "..." }` when it doesn't.
 */
export function canMoveToReview(
  projectDir: string,
  taskId: string,
): { allowed: boolean; reason?: string } {
  // First check: does the task exist at all?
  const tasks = listTasks(projectDir);
  const task = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
  if (!task) {
    return { allowed: false, reason: `Task not found: ${taskId}` };
  }

  // Check the task's files array for verification evidence
  if (task.files && task.files.length > 0) {
    const hasEvidence = task.files.some(
      (f) =>
        // Stryker disable next-line StringLiteral: pattern matching constant
        f.name.startsWith(VERIFY_EVIDENCE_PREFIX) &&
        // Stryker disable next-line StringLiteral: pattern matching constant
        f.name.endsWith(VERIFY_EVIDENCE_SUFFIX),
    );
    if (hasEvidence) {
      return { allowed: true };
    }
  }

  // Fallback: check the files directory on disk for verify-*.json files
  // (handles the case where evidence was written to disk but not yet
  // reflected in the task's files array)
  const filesDir = join(projectDir, PROTO_DIR, FILES_DIR, taskId);
  if (existsSync(filesDir)) {
    try {
      const entries = readdirSync(filesDir);
      const hasEvidence = entries.some(
        (name) =>
          // Stryker disable next-line StringLiteral: pattern matching constant
          name.startsWith(VERIFY_EVIDENCE_PREFIX) &&
          // Stryker disable next-line StringLiteral: pattern matching constant
          name.endsWith(VERIFY_EVIDENCE_SUFFIX),
      );
      if (hasEvidence) {
        return { allowed: true };
      }
    } catch {
      // Directory read failed — treat as no evidence
    }
  }

  return {
    allowed: false,
    reason: "Cannot move to review — run `vibeflow verify <id>` first.",
  };
}
