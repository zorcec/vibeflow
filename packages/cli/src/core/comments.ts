import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { TaskComment } from "./types.js";
import { readTaskFile, updateTask, findTaskFilePath, getTaskFilePath } from "./tasks.js";

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

export function listComments(projectDir: string, taskId: string): TaskComment[] {
  const filePath = findTaskFilePath(projectDir, taskId);
  const task = filePath ? readTaskFile(filePath) : null;
  return (task?.comments ?? []).filter((c) => !c.deleted).map(normalizeComment);
}

/**
 * Normalizes comment text by converting literal escape sequences (such as `\n`, `\t`,
 * `\r`, `\\`) into their actual character equivalents.
 *
 * LLM agents frequently build `--comment` shell arguments using double-quoted strings
 * where `\n` is passed as two ASCII characters (backslash + 'n') instead of an actual
 * newline — because bash double-quotes do not interpret escape sequences. This function
 * corrects that automatically, making it robust regardless of how the agent encodes
 * multi-line text.
 *
 * The replacement is done in a single regex pass to avoid double-substitution issues
 * (e.g. `\\n` correctly becomes a literal backslash + 'n', not a newline).
 */
export function normalizeCommentText(text: string): string {
  return text.replace(/\\(n|t|r|\\)/g, (_, c: string): string => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      default: return c;
    }
  });
}

export function addComment(
  projectDir: string,
  taskId: string,
  author: TaskComment["author"],
  text: string,
  files?: string[],
  type?: TaskComment["type"],
  source?: TaskComment["source"],
): TaskComment {
  text = normalizeCommentText(text);
  // Read all comments including soft-deleted entries to preserve them on write.
  const filePath = findTaskFilePath(projectDir, taskId);
  const task = filePath ? readTaskFile(filePath) : null;
  const allComments = task?.comments ?? [];
  const comment: TaskComment = {
    id: randomBytes(8).toString("hex"),
    author,
    text,
    ...(files && files.length > 0 ? { files } : {}),
    ...(type && type !== 'comment' ? { type } : {}),
    createdAt: new Date().toISOString(),
    source: source ?? 'cli',
  };
  const updated = [...allComments, comment];
  // updateTask returns null when the task file doesn't exist yet;
  // in that case write a bare entry so comments still persist.
  const result = updateTask(projectDir, taskId, { comments: updated });
  if (!result) {
    const targetPath = getTaskFilePath(projectDir, taskId, new Date().toISOString());
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify({ id: taskId, comments: updated }, null, 2), "utf-8");
  }
  return comment;
}

export function updateComment(
  projectDir: string,
  taskId: string,
  commentId: string,
  newText: string,
): TaskComment | null {
  // Read all comments including soft-deleted entries to preserve them on write.
  const filePath = findTaskFilePath(projectDir, taskId);
  const task = filePath ? readTaskFile(filePath) : null;
  const allComments = task?.comments ?? [];
  const comment = allComments.find((c) => c.id === commentId && !c.deleted);
  if (!comment) return null;
  comment.text = normalizeCommentText(newText);
  comment.updatedAt = new Date().toISOString();
  updateTask(projectDir, taskId, { comments: allComments });
  return normalizeComment(comment);
}

export function deleteComment(
  projectDir: string,
  taskId: string,
  commentId: string,
): boolean {
  // Read all comments including soft-deleted entries to preserve them on write.
  const filePath = findTaskFilePath(projectDir, taskId);
  const task = filePath ? readTaskFile(filePath) : null;
  const allComments = task?.comments ?? [];
  const idx = allComments.findIndex((c) => c.id === commentId && !c.deleted);
  if (idx === -1) return false;
  // Soft-delete: keep entry so the activity trace is preserved.
  allComments[idx] = {
    ...allComments[idx],
    deleted: true,
    text: '[Comment deleted]',
    updatedAt: new Date().toISOString(),
  };
  updateTask(projectDir, taskId, { comments: allComments });
  return true;
}

/** Returns the number of comments for a task (0 if none). */
export function getCommentCount(projectDir: string, taskId: string): number {
  return listComments(projectDir, taskId).length;
}
