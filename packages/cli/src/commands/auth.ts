import { readdirSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTO_DIR } from "../core/types.js";
import { ExitCode } from "../core/exit-codes.js";

/**
 * Glob pattern for per-task encrypted auth state files.
 * Files are named `.vibeflow/auth-state.<taskId>.enc`.
 */
const AUTH_STATE_PREFIX = "auth-state.";
const AUTH_STATE_SUFFIX = ".enc";

/**
 * Finds all per-task encrypted auth state files in `.vibeflow/`.
 */
function findAuthStateFiles(projectDir: string): string[] {
  const protoDir = join(projectDir, PROTO_DIR);
  if (!existsSync(protoDir)) return [];

  try {
    return readdirSync(protoDir)
      .filter(
        (name) =>
          name.startsWith(AUTH_STATE_PREFIX) &&
          name.endsWith(AUTH_STATE_SUFFIX),
      )
      .map((name) => join(protoDir, name));
  } catch {
    return [];
  }
}

/**
 * Deletes all per-task encrypted auth state files.
 *
 * Usage: `vibeflow auth --clear`
 *
 * @returns The number of files deleted.
 */
export function clearAuthState(projectDir: string): number {
  const files = findAuthStateFiles(projectDir);
  let deleted = 0;

  for (const filePath of files) {
    try {
      unlinkSync(filePath);
      deleted++;
    } catch {
      // File may have already been removed — ignore
    }
  }

  return deleted;
}

/**
 * Lists all per-task encrypted auth state files with metadata.
 *
 * @returns Array of file info objects.
 */
export function listAuthStateFiles(
  projectDir: string,
): Array<{ taskId: string; path: string; age: string }> {
  const files = findAuthStateFiles(projectDir);
  const result: Array<{ taskId: string; path: string; age: string }> = [];

  for (const filePath of files) {
    const basename = filePath.split("/").pop() ?? "";
    // Extract taskId from auth-state.<taskId>.enc
    const taskId = basename.slice(
      AUTH_STATE_PREFIX.length,
      -AUTH_STATE_SUFFIX.length,
    );

    if (!taskId) continue;

    let age = "unknown";
    try {
      const stat = statSync(filePath);
      const ageMs = Date.now() - stat.mtimeMs;
      const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
      if (ageHours < 1) {
        const ageMins = Math.floor(ageMs / (1000 * 60));
        age = `${ageMins}m`;
      } else if (ageHours < 24) {
        age = `${ageHours}h`;
      } else {
        age = `${Math.floor(ageHours / 24)}d`;
      }
    } catch {
      // stat failed — age remains "unknown"
    }

    result.push({ taskId, path: filePath, age });
  }

  return result;
}
