import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { TaskComment } from "./types.js";
import {
  readTaskFile,
  writeTaskJson,
  findTaskFilePath,
  getTaskFilePath,
  normalizeEscapeSequences,
} from "./tasks.js";
import { withTaskLock, taskLockPath } from "./lock.js";

/**
 * Normalizes a raw comment loaded from JSON, handling legacy formats:
 * - SaaS-format comments stored with a `body` field instead of `text`
 * - Comments missing an `author` field (defaults to "agent")
 *
 * These edge cases arise when agents wrote to task JSON files directly (against policy)
 * or when format migrations were incomplete. Normalization is applied on read so the
 * rest of the code can always rely on `text` and `author` being present.
 */
function normalizeComment(c: TaskComment): TaskComment {
  const raw = c as TaskComment & { body?: string };
  return {
    ...c,
    text: c.text || raw.body || "",
    author: c.author ?? "agent",
  };
}

export function listComments(
  projectDir: string,
  taskId: string,
): TaskComment[] {
  const filePath = findTaskFilePath(projectDir, taskId);
  const task = filePath ? readTaskFile(filePath) : null;
  return (task?.comments ?? []).filter((c) => !c.deleted).map(normalizeComment);
}

/**
 * Normalizes comment text by converting literal escape sequences (such as `\n`, `\t`,
 * `\r`, `\\`) into their actual character equivalents.
 *
 * Delegates to `normalizeEscapeSequences` from `tasks.ts` — the shared implementation
 * that also normalises task titles and descriptions — so the logic lives in one place.
 */
export function normalizeCommentText(text: string): string {
  return normalizeEscapeSequences(text);
}

export async function addComment(
  projectDir: string,
  taskId: string,
  author: TaskComment["author"],
  text: string,
  files?: string[],
  type?: TaskComment["type"],
  source?: TaskComment["source"],
): Promise<TaskComment> {
  text = normalizeCommentText(text);
  const lock = taskLockPath(projectDir, taskId);
  return withTaskLock(lock, () => {
    const filePath = findTaskFilePath(projectDir, taskId);
    const task = filePath ? readTaskFile(filePath) : null;
    const allComments = task?.comments ?? [];
    const comment: TaskComment = {
      id: randomBytes(8).toString("hex"),
      author,
      text,
      ...(files && files.length > 0 ? { files } : {}),
      ...(type && type !== "comment" ? { type } : {}),
      createdAt: new Date().toISOString(),
      source: source ?? "cli",
    };
    const updated = [...allComments, comment];
    if (task) {
      writeTaskJson(projectDir, { ...task, comments: updated });
    } else {
      // Task file doesn't exist yet — write a bare entry so comments still persist.
      const targetPath = getTaskFilePath(projectDir, taskId, new Date().toISOString());
      mkdirSync(dirname(targetPath), { recursive: true });
      const tmpPath = targetPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify({ id: taskId, comments: updated }, null, 2), "utf-8");
      renameSync(tmpPath, targetPath);
    }
    return comment;
  });
}

export async function updateComment(
  projectDir: string,
  taskId: string,
  commentId: string,
  newText: string,
): Promise<TaskComment | null> {
  const lock = taskLockPath(projectDir, taskId);
  return withTaskLock(lock, () => {
    const filePath = findTaskFilePath(projectDir, taskId);
    const task = filePath ? readTaskFile(filePath) : null;
    const allComments = task?.comments ?? [];
    const comment = allComments.find((c) => c.id === commentId && !c.deleted);
    if (!comment) return null;
    comment.text = normalizeCommentText(newText);
    comment.updatedAt = new Date().toISOString();
    if (task) writeTaskJson(projectDir, { ...task, comments: allComments });
    return normalizeComment(comment);
  });
}

export async function deleteComment(
  projectDir: string,
  taskId: string,
  commentId: string,
): Promise<boolean> {
  const lock = taskLockPath(projectDir, taskId);
  return withTaskLock(lock, () => {
    const filePath = findTaskFilePath(projectDir, taskId);
    const task = filePath ? readTaskFile(filePath) : null;
    const allComments = task?.comments ?? [];
    const idx = allComments.findIndex((c) => c.id === commentId && !c.deleted);
    if (idx === -1) return false;
    // Soft-delete: keep entry so the activity trace is preserved.
    allComments[idx] = {
      ...allComments[idx],
      deleted: true,
      text: "[Comment deleted]",
      updatedAt: new Date().toISOString(),
    };
    if (task) writeTaskJson(projectDir, { ...task, comments: allComments });
    return true;
  });
}

