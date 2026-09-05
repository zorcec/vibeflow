import type { Task, TaskStatus } from "./types.js";

/** All event types emitted by the watch engine. */
export type WatchEventType =
  | "new"
  | "moved-to-todo"
  | "status"
  | "comment"
  | "file"
  | "priority"
  | "description"
  | "gap";

export interface WatchEventBase {
  type: WatchEventType;
  taskId: string;
  timestamp: string; // ISO
}

export interface NewTaskEvent extends WatchEventBase {
  type: "new";
}

export interface MovedToTodoEvent extends WatchEventBase {
  type: "moved-to-todo";
}

export interface StatusChangeEvent extends WatchEventBase {
  type: "status";
  from: TaskStatus;
  to: TaskStatus;
}

export interface CommentEvent extends WatchEventBase {
  type: "comment";
  author: string;
  isNew: boolean;
  /** Number of comments after the change (used for diff detection). */
  commentCount: number;
  /** ISO timestamp of most recent comment after the change. */
  lastCommentAt: string;
}

export interface FileEvent extends WatchEventBase {
  type: "file";
  filename: string;
  isNew: boolean;
  /** Number of files after the change. */
  fileCount: number;
}

export interface PriorityEvent extends WatchEventBase {
  type: "priority";
  from: string | undefined;
  to: string | undefined;
}

export interface DescriptionEvent extends WatchEventBase {
  type: "description";
}

export interface GapEvent extends WatchEventBase {
  type: "gap";
  missedMinutes: number;
  message: string;
}

export type WatchEvent =
  | NewTaskEvent
  | MovedToTodoEvent
  | StatusChangeEvent
  | CommentEvent
  | FileEvent
  | PriorityEvent
  | DescriptionEvent
  | GapEvent;

/**
 * Snapshot of a task's watch-relevant fields at a point in time.
 * Used for diffing between two polling cycles.
 */
export interface TaskSnapshot {
  taskId: string;
  status: TaskStatus;
  priority: string | undefined;
  descriptionHash: string; // simple hash to detect changes
  commentCount: number;
  lastCommentAt: string | undefined; // ISO
  fileCount: number;
  /** ISO timestamp when this snapshot was taken. */
  takenAt: string;
}

function simpleHash(s: string): string {
  // Fast non-cryptographic hash for change detection only
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

export { simpleHash };

/**
 * Build a TaskSnapshot for a single task, including comment and file counts.
 * listComments reads from the task JSON; listFiles reads from the files dir.
 */
export function buildTaskSnapshot(
  task: Task,
  commentCount: number,
  lastCommentAt: string | undefined,
  fileCount: number,
  takenAt: string,
): TaskSnapshot {
  return {
    taskId: task.id,
    status: task.status,
    priority: task.priority,
    descriptionHash: simpleHash(task.description ?? ""),
    commentCount,
    lastCommentAt,
    fileCount,
    takenAt,
  };
}

/**
 * Reuses the existing classifyTaskUpdate logic for new/moved-to-todo semantics.
 */
export function classifyTaskUpdate(
  prevStatus: string | undefined,
  newStatus: string,
): "new" | "moved-to-todo" | null {
  if (prevStatus === undefined) return "new";
  if (prevStatus !== "todo" && newStatus === "todo") return "moved-to-todo";
  return null;
}

/**
 * Diff two snapshots of the same task and emit WatchEvents.
 * prev may be undefined (task is new).
 * Returns events in chronological order.
 */
export function diffTaskSnapshots(
  task: Task,
  prev: TaskSnapshot | undefined,
  next: TaskSnapshot,
): WatchEvent[] {
  const events: WatchEvent[] = [];
  const ts = next.takenAt;

  // 1. New / moved-to-todo (reuse existing logic)
  const kind = classifyTaskUpdate(prev?.status, next.status);
  if (kind === "new") {
    events.push({ type: "new", taskId: task.id, timestamp: ts });
  } else if (kind === "moved-to-todo") {
    events.push({ type: "moved-to-todo", taskId: task.id, timestamp: ts });
  }

  // 2. Status change (any non-new status transition)
  if (prev && prev.status !== next.status && kind !== "new") {
    events.push({
      type: "status",
      taskId: task.id,
      timestamp: ts,
      from: prev.status,
      to: next.status,
    });
  }

  // 3. Comment change
  if (prev && prev.commentCount !== next.commentCount) {
    events.push({
      type: "comment",
      taskId: task.id,
      timestamp: ts,
      author: "user", // don't know who without reading full comment list
      isNew: next.commentCount > prev.commentCount,
      commentCount: next.commentCount,
      lastCommentAt: next.lastCommentAt ?? ts,
    });
  }

  // 4. File change
  if (prev && prev.fileCount !== next.fileCount) {
    events.push({
      type: "file",
      taskId: task.id,
      timestamp: ts,
      filename: "", // don't track which file without reading full file list
      isNew: next.fileCount > prev.fileCount,
      fileCount: next.fileCount,
    });
  }

  // 5. Priority change
  if (prev && prev.priority !== next.priority) {
    events.push({
      type: "priority",
      taskId: task.id,
      timestamp: ts,
      from: prev.priority,
      to: next.priority,
    });
  }

  // 6. Description change
  if (prev && prev.descriptionHash !== next.descriptionHash) {
    events.push({ type: "description", taskId: task.id, timestamp: ts });
  }

  return events;
}
