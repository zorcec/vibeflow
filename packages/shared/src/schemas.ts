import { z } from "zod";

export const taskStatusValues = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
] as const;

export type SaasTaskStatus = (typeof taskStatusValues)[number];

/**
 * Single source of truth for the task description length cap. Imported by
 * the web create/update schemas AND the overlay collection schema — every
 * writer enforces the same width (the overlay used to drift at half this).
 * The DB column is `text` (unbounded); this cap is the product limit.
 */
export const TASK_DESCRIPTION_MAX = 20_000;

/**
 * Human sentence for an over-limit description, mapped at the call site
 * (overlay route, panel save guard) instead of surfacing a raw Zod
 * BAD_REQUEST. `formatDescriptionTooLong(21431)` =
 * `"Description is 21,431 characters; the limit is 20,000."`
 */
export function formatDescriptionTooLong(actualLength: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `Description is ${fmt(actualLength)} characters; the limit is ${fmt(TASK_DESCRIPTION_MAX)}.`;
}

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  description: z.string().max(500).optional(),
});

export const createProjectSchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
});

export const createBoardSchema = z.object({
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(255),
});

export const createTaskSchema = z.object({
  workspaceId: z.string().min(1),
  boardId: z.string().min(1),
  title: z.string().min(1).max(255),
  description: z.string().max(TASK_DESCRIPTION_MAX).nullish(),
  status: z.enum(taskStatusValues).default("todo"),
  type: z.string().max(50).nullish(),
  priority: z.string().max(50).nullish(),
  assigneeId: z.string().nullish(),
  agent: z.string().max(255).nullish(),
  model: z.string().max(255).nullish(),
  selector: z.string().max(1_000).nullish(),
  cssSelector: z.string().max(1_000).nullish(),
  file: z.string().max(1_000).nullish(),
  line: z.number().int().nullish(),
  col: z.number().int().nullish(),
  component: z.string().max(255).nullish(),
  url: z.string().max(2_000).nullish(),
  reportBack: z.boolean().nullish(),
  author: z.string().max(255).nullish(),
  annotatedElementText: z.string().max(300).nullish(),
  sortKey: z.string().optional(),
});

export const updateTaskSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  patch: z.object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(TASK_DESCRIPTION_MAX).nullish(),
    status: z.enum(taskStatusValues).optional(),
    type: z.string().max(50).nullish(),
    priority: z.string().max(50).nullish(),
    assigneeId: z.string().nullish(),
    agent: z.string().max(255).nullish(),
    model: z.string().max(255).nullish(),
    selector: z.string().max(1_000).nullish(),
    cssSelector: z.string().max(1_000).nullish(),
    file: z.string().max(1_000).nullish(),
    line: z.number().int().nullish(),
    col: z.number().int().nullish(),
    component: z.string().max(255).nullish(),
    url: z.string().max(2_000).nullish(),
    reportBack: z.boolean().nullish(),
    commit: z.string().max(2_000).nullish(),
    commits: z
      .array(
        z.object({
          sha: z.string(),
          message: z.string().max(2_000),
          timestamp: z.string(),
        }),
      )
      .max(100)
      .nullish(),
    author: z.string().max(255).nullish(),
    // Branch tile (#dp-branch): DetailPanel sends this on status/review
    // writes — without it zod strips the key and the tile never renders.
    branchName: z.string().max(255).nullish(),
    // Tri-state agent attestation: true = verified correct, false = verified
    // wrong, null = clear to absent. Absent (omitted) leaves it untouched.
    verified: z.boolean().nullish(),
    sortKey: z.string().optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
    links: z
      .array(
        z.object({
          taskId: z.string().min(1),
          type: z.enum(["parent", "relates", "blocks"]),
        }),
      )
      .max(200)
      .nullish(),
  }),
});

export const deleteTaskSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  unlinkChildren: z.boolean().optional(),
});

export const listTasksSchema = z.object({
  workspaceId: z.string().min(1),
  boardId: z.string().min(1),
});

export const createCommentSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  body: z.string().min(1).max(10_000),
});

export const updateCommentSchema = z.object({
  workspaceId: z.string().min(1),
  commentId: z.string().min(1),
  body: z.string().min(1).max(10_000),
});

export const deleteCommentSchema = z.object({
  workspaceId: z.string().min(1),
  commentId: z.string().min(1),
});

export const listCommentsSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
});

export const deviceInitResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string().url(),
  expiresIn: z.number(),
});

export const devicePollRequestSchema = z.object({
  deviceCode: z.string().min(1),
});

export const devicePollResponseSchema = z.union([
  z.object({ pending: z.literal(true) }),
  z.object({ token: z.string().min(1) }),
  z.object({ expired: z.literal(true) }),
]);
