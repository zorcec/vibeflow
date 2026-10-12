/**
 * Commit-tag convention — one module so the next rename is one line.
 *
 * New commits are tagged `[vibeflow:<taskId>]`. Commits written by older CLI
 * versions carry `[proto:<taskId>]`; the parser accepts BOTH so history and
 * in-flight lanes keep linking. Emit via {@link formatCommitTag}, read via
 * {@link parseCommitTag} — never hand-roll the literal.
 */

export const COMMIT_TAG_PREFIX = "vibeflow";
export const LEGACY_COMMIT_TAG_PREFIX = "proto";

/** `[vibeflow:<taskId>]` — the tag appended to every task commit message. */
export function formatCommitTag(taskId: string): string {
  return `[${COMMIT_TAG_PREFIX}:${taskId}]`;
}

/**
 * Extracts the task id from a commit message tagged by {@link formatCommitTag}
 * or by the legacy `[proto:<taskId>]` form. Returns null when untagged.
 * When both forms are present (should not happen), the new form wins.
 */
export function parseCommitTag(message: string): string | null {
  const fresh = message.match(/\[vibeflow:([^\]\s]+)\]/);
  if (fresh) return fresh[1];
  const legacy = message.match(/\[proto:([^\]\s]+)\]/);
  return legacy ? legacy[1] : null;
}

/** True when `message` carries the tag for `taskId` in either form. */
export function hasCommitTag(message: string, taskId: string): boolean {
  return parseCommitTag(message) === taskId;
}
