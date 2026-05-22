/**
 * tRPC router for the Proto server.
 *
 * Exposes all core task/comment/file/project operations as tRPC procedures,
 * mounted at /trpc by the Express server (alongside the existing REST API).
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { getProjectName } from "../core/config.js";
import {
  createTask,
  listTasks,
  updateTask,
  deleteTask,
} from "../core/tasks.js";
import {
  listComments,
  addComment,
  updateComment,
  deleteComment,
} from "../core/comments.js";
import { listFiles, getFileCount } from "../core/files.js";
import { getCopilotAuthStatus, isGhCliAvailable } from "../core/copilot-auth.js";
import type { Task } from "../core/types.js";

export interface TrpcContext {
  projectDir: string;
  broadcast: (data: object) => void;
}

const t = initTRPC.context<TrpcContext>().create();

const router = t.router;
const procedure = t.procedure;

// ── Shared Zod schemas ─────────────────────────────────────────────────────

const taskStatusSchema = z.enum(["backlog", "todo", "in-progress", "review", "done"]);

const taskIdInput = z.object({ id: z.string().min(1) });

// ── App router ─────────────────────────────────────────────────────────────

export const appRouter = router({
  // ── Project ──────────────────────────────────────────────────────────────

  project: procedure.query(({ ctx }) => {
    return { name: getProjectName(ctx.projectDir), projectDir: ctx.projectDir };
  }),

  copilotStatus: procedure.query(async ({ ctx }) => {
    const ghAvailable = await isGhCliAvailable();
    if (!ghAvailable) {
      return { authenticated: false, reason: "gh CLI not found" };
    }
    const result = await getCopilotAuthStatus(ctx.projectDir);
    return result;
  }),

  // ── Tasks ─────────────────────────────────────────────────────────────────

  tasks: procedure.query(({ ctx }) => {
    const tasks = listTasks(ctx.projectDir);
    const tasksWithMeta = tasks.map((task) => ({
      ...task,
      createdAt: task.created,
      commentCount: (task.comments ?? []).length,
      fileCount: getFileCount(ctx.projectDir, task.id),
    }));
    return { tasks: tasksWithMeta };
  }),

  searchTasks: procedure
    .input(
      z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        pageScope: z.string().optional(),
      }),
    )
    .query(({ ctx, input }) => {
      const tasks = listTasks(ctx.projectDir);
      const limit = Math.max(1, input.limit ?? 10);
      const lc = input.query.toLowerCase();

      const matches = tasks
        .filter((t) => {
          const text = `${t.title} ${t.description ?? ""} ${t.type ?? ""} ${t.component ?? ""}`;
          return text.toLowerCase().includes(lc);
        })
        .slice(0, limit)
        .map((task) => ({
          score: 1,
          task,
          commentCount: (task.comments ?? []).length,
          fileCount: getFileCount(ctx.projectDir, task.id),
        }));
      return { results: matches };
    }),

  createTask: procedure
    .input(
      z.object({
        title: z.string().min(1),
        selector: z.string().min(1),
        description: z.string().optional(),
        cssSelector: z.string().optional(),
        url: z.string().optional(),
        type: z.string().optional(),
        priority: z.string().optional(),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        col: z.number().int().positive().optional(),
        component: z.string().optional(),
        status: taskStatusSchema.optional(),
        agent: z.string().optional(),
        model: z.string().optional(),
        author: z.string().optional(),
        annotatedElementText: z.string().max(300).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const task = createTask(ctx.projectDir, {
        title: input.title,
        description: input.description ?? "",
        selector: input.selector,
        cssSelector: input.cssSelector,
        url: input.url,
        status: input.status ?? "todo",
        screenshot: undefined,
        file: input.file,
        line: input.line,
        col: input.col,
        component: input.component,
        type: input.type,
        priority: input.priority,
        author: input.author ?? "Unknown",
        agent: input.agent,
        model: input.model,
        annotatedElementText: input.annotatedElementText,
      });
      ctx.broadcast({ type: "tasks-updated" });
      return { success: true, task };
    }),

  updateTask: procedure
    .input(
      z.object({
        id: z.string().min(1),
        updates: z.object({
          status: taskStatusSchema.optional(),
          title: z.string().min(1).optional(),
          description: z.string().optional(),
          type: z.string().optional(),
          priority: z.string().optional(),
          reportBack: z.boolean().optional(),
          agent: z.string().optional(),
          model: z.string().optional(),
        }),
      }),
    )
    .mutation(({ ctx, input }) => {
      const updated = updateTask(
        ctx.projectDir,
        input.id,
        input.updates as Partial<Pick<Task, "status" | "title" | "description" | "type" | "priority" | "reportBack" | "agent" | "model">>,
      );
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      }
      ctx.broadcast({ type: "tasks-updated" });
      return { success: true, task: updated };
    }),

  deleteTask: procedure
    .input(taskIdInput)
    .mutation(({ ctx, input }) => {
      const deleted = deleteTask(ctx.projectDir, input.id);
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      }
      ctx.broadcast({ type: "tasks-updated" });
      return { success: true };
    }),

  // ── Comments ──────────────────────────────────────────────────────────────

  comments: procedure
    .input(taskIdInput)
    .query(({ ctx, input }) => {
      const comments = listComments(ctx.projectDir, input.id);
      return { comments };
    }),

  addComment: procedure
    .input(
      z.object({
        taskId: z.string().min(1),
        text: z.string().min(1),
        author: z.enum(["user", "agent"]).optional().default("user"),
        files: z.array(z.string()).optional(),
        source: z.enum(["cli", "web"]).optional().default("web"),
      }),
    )
    .mutation(({ ctx, input }) => {
      const comment = addComment(
        ctx.projectDir,
        input.taskId,
        input.author,
        input.text.trim(),
        input.files,
        undefined,
        input.source,
      );
      ctx.broadcast({ type: "tasks-updated" });
      return { success: true, comment };
    }),

  updateComment: procedure
    .input(
      z.object({
        taskId: z.string().min(1),
        commentId: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      const comment = updateComment(
        ctx.projectDir,
        input.taskId,
        input.commentId,
        input.text.trim(),
      );
      if (!comment) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
      }
      return { success: true, comment };
    }),

  deleteComment: procedure
    .input(
      z.object({
        taskId: z.string().min(1),
        commentId: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) => {
      deleteComment(ctx.projectDir, input.taskId, input.commentId);
      ctx.broadcast({ type: "tasks-updated" });
      return { success: true };
    }),

  // ── Files ─────────────────────────────────────────────────────────────────

  files: procedure
    .input(taskIdInput)
    .query(({ ctx, input }) => {
      const files = listFiles(ctx.projectDir, input.id);
      return { files };
    }),

  // ── Models ─────────────────────────────────────────────────────────────────

  models: procedure.query(async () => {
    try {
      const { execSync } = await import("node:child_process");
      const output = execSync("opencode models", { encoding: "utf-8", timeout: 10000 });
      const modelIds = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));

      // Parse provider/model format into structured data
      const models = modelIds.map((id) => {
        const parts = id.split("/");
        const provider = parts[0] || "other";
        const modelId = parts.slice(1).join("/") || id;
        // Generate a human-readable label
        const label = modelId
          .replace(/-/g, " ")
          .replace(/(\d+\.\d+)/, "v$1")
          .replace(/\b\w/g, (c) => c.toUpperCase());

        return { id, label, provider };
      });

      return { models, error: null };
    } catch (err) {
      // OpenCode not installed or command failed
      const message = err instanceof Error ? err.message : "Unknown error";
      return { models: [], error: `OpenCode not found: ${message}` };
    }
  }),

});

export type AppRouter = typeof appRouter;
