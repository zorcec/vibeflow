import type { Task, Comment } from "../src";

/**
 * Shared story fixtures.
 *
 * Stories were each inventing their own task objects, which drifted: one
 * story's "task" had a `status` value that no longer exists, another forgot
 * `links` and crashed the panel. One factory, one shape.
 */

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "A representative task",
    description: "A description with **markdown** and a list:\n\n- one\n- two",
    status: "todo",
    type: "task",
    priority: "medium",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    tags: ["frontend"],
    links: [],
    commentCount: 2,
    fileCount: 1,
    ...overrides,
  } as Task;
}

export function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "comment-1",
    author: "ana",
    authorName: "Ana Novak",
    text: "A comment body",
    createdAt: "2026-01-03T00:00:00.000Z",
    type: "comment",
    ...overrides,
  } as Comment;
}

export function fileEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    name: "screenshot.png",
    size: 2048,
    contentType: "image/png",
    createdAt: "2026-01-03T00:00:00.000Z",
    uploaderName: "Ana Novak",
    ...overrides,
  };
}

/** Matches `WorkspaceMemberOverviewItem` exactly — the panel reads
 *  `displayName` and `emailVerified`, not `name`/`verified`, and a mismatch
 *  crashed the render. */
export function member(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    displayName: "Ana Novak",
    email: "ana@example.test",
    role: "member",
    emailVerified: true,
    ...overrides,
  };
}

export const ALL_STATUSES = ["backlog", "todo", "in-progress", "review", "done"];

/**
 * `StatusConfig[]`, which is what the panels take — NOT a list of ids.
 * Passing strings produced buttons with no text (and six axe button-name
 * violations), because the label came from `s.label`.
 */
export const STATUS_CONFIGS = ALL_STATUSES.map((id, i) => ({
  id,
  label: id === "in-progress" ? "In Progress" : id.charAt(0).toUpperCase() + id.slice(1),
  color: ["#94a3b8", "#fcd34d", "#93c5fd", "#c4b5fd", "#6ee7b7"][i]!,
}));
