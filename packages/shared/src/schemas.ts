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
  description: z.string().max(10_000).nullish(),
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
    description: z.string().max(10_000).nullish(),
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
    sortKey: z.string().optional(),
    tags: z.array(z.string().max(50)).max(20).optional(),
  }),
});

export const deleteTaskSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
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
