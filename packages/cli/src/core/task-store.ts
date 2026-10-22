import type { Task, TaskComment } from "./types.js";
import type { FileInfo } from "./files.js";
import type { TaskReadFinding } from "./task-record-read.js";
import * as tasksModule from "./tasks.js";
import * as commentsModule from "./comments.js";
import * as filesModule from "./files.js";

/**
 * P1 seam (ticket 7339393c): the ONE boundary P2/P3 will extend with a
 * `RemoteTaskStore` + token-based selection. Behaviour-neutral by design —
 * `LocalTaskStore` below delegates to today's file-backed functions with no
 * logic moved and no call site changed yet.
 */

export type TaskCreateInput = Omit<
  Task,
  "id" | "created" | "comments" | "files"
>;
export type TaskUpdateInput = Partial<Omit<Task, "id" | "created">>;

/** One writable-copy-at-a-time store over tasks, comments, and file refs. */
export interface TaskStore {
  listTasks(projectDir: string, reads?: TaskReadFinding[]): Task[];
  getTask(projectDir: string, idOrPrefix: string): Task | undefined;
  createTask(projectDir: string, input: TaskCreateInput): Task;
  updateTask(
    projectDir: string,
    taskId: string,
    updates: TaskUpdateInput,
  ): Task | null;
  deleteTask(projectDir: string, taskId: string): boolean;
  listComments(projectDir: string, taskId: string): TaskComment[];
  addComment(
    projectDir: string,
    taskId: string,
    author: TaskComment["author"],
    text: string,
    files?: string[],
    type?: TaskComment["type"],
    source?: TaskComment["source"],
  ): Promise<TaskComment>;
  updateComment(
    projectDir: string,
    taskId: string,
    commentId: string,
    newText: string,
  ): Promise<TaskComment | null>;
  deleteComment(
    projectDir: string,
    taskId: string,
    commentId: string,
  ): Promise<boolean>;
  listFiles(projectDir: string, taskId: string): FileInfo[];
  saveFile(
    projectDir: string,
    taskId: string,
    filename: string,
    data: Buffer,
    opts?: { system?: boolean },
  ): FileInfo;
  deleteFile(projectDir: string, taskId: string, filename: string): boolean;
  getFilePath(
    projectDir: string,
    taskId: string,
    filename: string,
  ): string | null;
  getFileCount(projectDir: string, taskId: string): number;
}

/**
 * File-backed `TaskStore`: every method delegates 1:1 to the existing
 * `core/tasks.ts`, `core/comments.ts`, and `core/files.ts` functions.
 * No logic lives here — a spy on the underlying module proves delegation.
 */
export class LocalTaskStore implements TaskStore {
  listTasks(projectDir: string, reads?: TaskReadFinding[]): Task[] {
    return tasksModule.listTasks(projectDir, reads);
  }

  getTask(projectDir: string, idOrPrefix: string): Task | undefined {
    return tasksModule.findTaskByIdOrPrefix(projectDir, idOrPrefix);
  }

  createTask(projectDir: string, input: TaskCreateInput): Task {
    return tasksModule.createTask(projectDir, input);
  }

  updateTask(
    projectDir: string,
    taskId: string,
    updates: TaskUpdateInput,
  ): Task | null {
    return tasksModule.updateTask(projectDir, taskId, updates);
  }

  deleteTask(projectDir: string, taskId: string): boolean {
    return tasksModule.deleteTask(projectDir, taskId);
  }

  listComments(projectDir: string, taskId: string): TaskComment[] {
    return commentsModule.listComments(projectDir, taskId);
  }

  addComment(
    projectDir: string,
    taskId: string,
    author: TaskComment["author"],
    text: string,
    files?: string[],
    type?: TaskComment["type"],
    source?: TaskComment["source"],
  ): Promise<TaskComment> {
    return commentsModule.addComment(
      projectDir,
      taskId,
      author,
      text,
      files,
      type,
      source,
    );
  }

  updateComment(
    projectDir: string,
    taskId: string,
    commentId: string,
    newText: string,
  ): Promise<TaskComment | null> {
    return commentsModule.updateComment(projectDir, taskId, commentId, newText);
  }

  deleteComment(
    projectDir: string,
    taskId: string,
    commentId: string,
  ): Promise<boolean> {
    return commentsModule.deleteComment(projectDir, taskId, commentId);
  }

  listFiles(projectDir: string, taskId: string): FileInfo[] {
    return filesModule.listFiles(projectDir, taskId);
  }

  saveFile(
    projectDir: string,
    taskId: string,
    filename: string,
    data: Buffer,
    opts?: { system?: boolean },
  ): FileInfo {
    return filesModule.saveFile(projectDir, taskId, filename, data, opts);
  }

  deleteFile(
    projectDir: string,
    taskId: string,
    filename: string,
  ): boolean {
    return filesModule.deleteFile(projectDir, taskId, filename);
  }

  getFilePath(
    projectDir: string,
    taskId: string,
    filename: string,
  ): string | null {
    return filesModule.getFilePath(projectDir, taskId, filename);
  }

  getFileCount(projectDir: string, taskId: string): number {
    return filesModule.getFileCount(projectDir, taskId);
  }
}

/** Shared file-backed store instance (selection by auth state lands in P3). */
export const localTaskStore = new LocalTaskStore();
