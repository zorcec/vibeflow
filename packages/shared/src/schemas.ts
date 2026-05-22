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
  description: z.string().nullish(),
  status: z.enum(taskStatusValues).default("todo"),
  type: z.string().nullish(),
  priority: z.string().nullish(),
  assigneeId: z.string().nullish(),
  agent: z.string().nullish(),
  model: z.string().nullish(),
  selector: z.string().nullish(),
  cssSelector: z.string().nullish(),
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  col: z.number().int().nullish(),
  component: z.string().nullish(),
  url: z.string().nullish(),
  reportBack: z.boolean().nullish(),
  author: z.string().nullish(),
  annotatedElementText: z.string().max(300).nullish(),
  sortKey: z.string().optional(),
});

export const updateTaskSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  patch: z.object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().nullish(),
    status: z.enum(taskStatusValues).optional(),
    type: z.string().nullish(),
    priority: z.string().nullish(),
    assigneeId: z.string().nullish(),
    agent: z.string().nullish(),
    model: z.string().nullish(),
    selector: z.string().nullish(),
    cssSelector: z.string().nullish(),
    file: z.string().nullish(),
    line: z.number().int().nullish(),
    col: z.number().int().nullish(),
    component: z.string().nullish(),
    url: z.string().nullish(),
    reportBack: z.boolean().nullish(),
    commit: z.string().nullish(),
    commits: z.array(z.object({ sha: z.string(), message: z.string(), timestamp: z.string() })).nullish(),
    author: z.string().nullish(),
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
  body: z.string().min(1),
});

export const updateCommentSchema = z.object({
  workspaceId: z.string().min(1),
  commentId: z.string().min(1),
  body: z.string().min(1),
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
