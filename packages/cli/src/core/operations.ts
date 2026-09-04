/**
 * MCP Operations Layer
 *
 * Thin wrappers over core functions that MCP tools call.
 * These operations handle context resolution (projectDir, mode, userId)
 * and delegate to the existing core functions.
 */
import { z } from "zod";
import type { Task, TaskComment } from "../core/types.js";
import {
  TASK_STATUSES,
  compareTasksByPriorityThenCreated,
  type TaskStatus,
} from "../core/types.js";
import type { FileInfo } from "../core/files.js";

// ── Context ────────────────────────────────────────────────────────────────

export interface OperationContext {
  projectDir: string;
  mode: "local" | "saas";
  userId?: string;
  workspaceId?: string;
  dryRun?: boolean;
}

// ── Result wrapper ─────────────────────────────────────────────────────────

export interface OperationResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    suggestion?: string;
  };
  steps?: string[];
}

// ── Schemas ────────────────────────────────────────────────────────────────

export const ListTasksInput = z.object({
  // SAFETY: TASK_STATUSES is canonical; z.enum needs mutable tuple
  status: z
    .enum(TASK_STATUSES as unknown as [string, ...string[]])
    .optional(),
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .optional(),
  user: z.string().optional(),
  tag: z.array(z.string()).optional(),
  limit: z.number().min(0).default(5),
  fields: z.array(z.string()).optional(),
});
export type ListTasksInputType = z.infer<typeof ListTasksInput>;

export const GetTaskInput = z.object({
  id: z.string().min(1),
  fields: z.array(z.string()).optional(),
});
export type GetTaskInputType = z.infer<typeof GetTaskInput>;

export const CreateTaskInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  // SAFETY: TASK_STATUSES is a readonly tuple; z.enum requires a mutable tuple type.
  status: z
    .enum(TASK_STATUSES as unknown as [string, ...string[]])
    .default("todo"),
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .default("Task"),
  priority: z.enum(["Critical", "High", "Medium", "Low"]).default("Medium"),
  tags: z.array(z.string()).optional(),
  url: z.string().optional(),
  selector: z.string().default("/"),
  cssSelector: z.string().optional(),
});
export type CreateTaskInputType = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  id: z.string().min(1),
  // SAFETY: TASK_STATUSES is a readonly tuple; z.enum requires a mutable tuple type.
  status: z
    .enum(TASK_STATUSES as unknown as [string, ...string[]])
    .optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  branch: z.string().optional(),
  comment: z.string().optional(),
  commitMessage: z.string().optional(),
  skipVerify: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
export type UpdateTaskInputType = z.infer<typeof UpdateTaskInput>;

export const ClaimNextTaskInput = z.object({
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .optional(),
  user: z.string().optional(),
  tag: z.array(z.string()).optional(),
  dryRun: z.boolean().default(false),
});
export type ClaimNextTaskInputType = z.infer<typeof ClaimNextTaskInput>;

export const AddCommentInput = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  author: z.enum(["agent", "user"]).default("agent"),
});
export type AddCommentInputType = z.infer<typeof AddCommentInput>;

export const AttachFileInput = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  contentB64: z.string().min(1),
});
export type AttachFileInputType = z.infer<typeof AttachFileInput>;

export const ExportPromptInput = z.object({
  id: z.string().optional(),
  ids: z.array(z.string()).optional(),
  format: z.enum(["markdown", "json"]).default("markdown"),
});
export type ExportPromptInputType = z.infer<typeof ExportPromptInput>;

export const VerifyTaskInput = z.object({
  id: z.string().min(1),
  url: z.string().url().optional(),
  timeoutMs: z.number().min(1000).max(300000).default(60000),
});
export type VerifyTaskInputType = z.infer<typeof VerifyTaskInput>;

export const PushTasksInput = z.object({
  workspace: z.string().optional(),
  keepLocalFiles: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
export type PushTasksInputType = z.infer<typeof PushTasksInput>;

// ── Operations ─────────────────────────────────────────────────────────────

export async function listTasks(
  ctx: OperationContext,
  input: ListTasksInputType,
): Promise<OperationResult<{ tasks: Task[]; total: number }>> {
  try {
    // Dynamic import to avoid circular dependencies
    const { listTasks: coreListTasks } = await import("../core/tasks.js");
    let tasks = coreListTasks(ctx.projectDir);

    // Apply filters
    if (input.status) {
      tasks = tasks.filter((t) => t.status === input.status);
    }
    if (input.type) {
      tasks = tasks.filter((t) => t.type === input.type);
    }
    if (input.user) {
      tasks = tasks.filter((t) => t.author === input.user);
    }
    if (input.tag && input.tag.length > 0) {
      tasks = tasks.filter(
        (t) => t.tags && input.tag!.every((tag) => t.tags!.includes(tag)),
      );
    }

    const total = tasks.length;

    // Apply limit
    if (input.limit > 0) {
      tasks = tasks.slice(0, input.limit);
    }

    // Apply field selection
    if (input.fields && input.fields.length > 0) {
      const fieldSet = new Set(input.fields);
      tasks = tasks.map((t) => {
        const filtered: Record<string, unknown> = {};
        for (const key of Object.keys(t)) {
          if (fieldSet.has(key)) {
            // SAFETY: Task is a plain JSON object; runtime keys match the type's properties
            filtered[key] = (t as unknown as Record<string, unknown>)[key];
          }
        }
        // SAFETY: filtered contains a subset of Task's keys; partial Task is still structurally valid for JSON serialization
        return filtered as unknown as Task;
      });
    }

    return { ok: true, data: { tasks, total } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "LIST_TASKS_ERROR",
        message: err instanceof Error ? err.message : "Failed to list tasks",
      },
    };
  }
}

export async function getTask(
  ctx: OperationContext,
  input: GetTaskInputType,
): Promise<OperationResult<Task>> {
  try {
    const { findTaskFilePath, readTaskFile } = await import("../core/tasks.js");
    const filePath = findTaskFilePath(ctx.projectDir, input.id);
    if (!filePath) {
      return {
        ok: false,
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task not found: ${input.id}`,
          suggestion: "Check the task ID and try again",
        },
      };
    }
    const task = readTaskFile(filePath);
    if (!task) {
      return {
        ok: false,
        error: {
          code: "TASK_READ_ERROR",
          message: `Failed to read task: ${input.id}`,
        },
      };
    }

    // Apply field selection
    if (input.fields && input.fields.length > 0) {
      const fieldSet = new Set(input.fields);
      const filtered: Record<string, unknown> = {};
      for (const key of Object.keys(task)) {
        if (fieldSet.has(key)) {
          // SAFETY: Task is a plain JSON object; runtime keys match the type's properties
          filtered[key] = (task as unknown as Record<string, unknown>)[key];
        }
      }
      // SAFETY: filtered contains a subset of Task's keys; partial Task is still structurally valid for JSON serialization
      return { ok: true, data: filtered as unknown as Task };
    }

    return { ok: true, data: task };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "GET_TASK_ERROR",
        message: err instanceof Error ? err.message : "Failed to get task",
      },
    };
  }
}

export async function createTask(
  ctx: OperationContext,
  input: CreateTaskInputType,
): Promise<OperationResult<Task>> {
  try {
    if (ctx.dryRun) {
      return {
        ok: true,
        data: {
          id: "dry-run",
          title: input.title,
          description: input.description ?? "",
          status: input.status as TaskStatus,
          selector: input.selector,
          created: new Date().toISOString(),
        } as Task,
        steps: ["Dry run: task would be created"],
      };
    }

    const { createTask: coreCreateTask } = await import("../core/tasks.js");
    const task = coreCreateTask(ctx.projectDir, {
      title: input.title,
      description: input.description ?? "",
      status: input.status as TaskStatus,
      type: input.type,
      priority: input.priority,
      tags: input.tags,
      url: input.url,
      selector: input.selector,
      cssSelector: input.cssSelector,
    });

    return { ok: true, data: task };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "CREATE_TASK_ERROR",
        message: err instanceof Error ? err.message : "Failed to create task",
      },
    };
  }
}

export async function updateTask(
  ctx: OperationContext,
  input: UpdateTaskInputType,
): Promise<OperationResult<Task>> {
  try {
    const { findTaskFilePath, readTaskFile } = await import(
      "../core/tasks.js"
    );
    const filePath = findTaskFilePath(ctx.projectDir, input.id);
    const existingTask = filePath ? readTaskFile(filePath) : null;
    if (!existingTask) {
      return {
        ok: false,
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task not found: ${input.id}`,
        },
      };
    }

    // Gate: review transition check (runs before any writes, including dry-run)
    if (input.status === "review") {
      const { loadSettings } = await import("../core/settings.js");
      const { checkReviewTransition } = await import("../core/review-gate.js");
      const settings = loadSettings(ctx.projectDir);
      const gate = checkReviewTransition(
        ctx.projectDir,
        input.id,
        {
          comment: input.comment,
          commitMessage: input.commitMessage,
          skipVerify: input.skipVerify,
        },
        { projectDir: ctx.projectDir, settings },
      );
      if (!gate.ok) {
        return {
          ok: false,
          error: { code: gate.code, message: gate.message, suggestion: gate.suggestion },
        };
      }
    }

    // Dry-run: return preview (after gate check so would-be failures are reported)
    if (ctx.dryRun) {
      return {
        ok: true,
        data: existingTask,
        steps: ["Dry run: task would be updated"],
      };
    }

    const { updateTask: coreUpdateTask } = await import("../core/tasks.js");
    const updates: Record<string, unknown> = {};
    if (input.status) updates.status = input.status;
    if (input.title) updates.title = input.title;
    if (input.description !== undefined)
      updates.description = input.description;
    if (input.branch) updates.branchName = input.branch;

    // Verified reset on in-progress (parity with CLI edit path)
    if (input.status === "in-progress") {
      updates.verified = false;
    }

    const task = coreUpdateTask(ctx.projectDir, input.id, updates);
    if (!task) {
      return {
        ok: false,
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task not found: ${input.id}`,
        },
      };
    }

    // Comment is added only after all gates pass (same ordering as CLI)
    if (input.comment) {
      const { addComment } = await import("../core/comments.js");
      addComment(ctx.projectDir, input.id, "agent", input.comment);
    }

    // Auto-commit after review transition (parity with CLI auto-commit path)
    const steps: string[] = [];
    if (input.status === "review" && input.commitMessage) {
      const { loadSettings } = await import("../core/settings.js");
      const { commitTaskChanges } = await import("../core/git.js");
      const settings = loadSettings(ctx.projectDir);
      if (settings.autoCommit) {
        const commitResult = commitTaskChanges(
          ctx.projectDir,
          task.id,
          input.commitMessage,
        );
        if (commitResult.ok) {
          steps.push(`Committed: ${commitResult.sha}`);
        } else {
          steps.push(`Commit failed: ${commitResult.error}`);
        }
      }
    }

    return { ok: true, data: task, steps: steps.length > 0 ? steps : undefined };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "UPDATE_TASK_ERROR",
        message: err instanceof Error ? err.message : "Failed to update task",
      },
    };
  }
}

export async function claimNextTask(
  ctx: OperationContext,
  input: ClaimNextTaskInputType,
): Promise<OperationResult<Task>> {
  try {
    if (ctx.dryRun) {
      const { listTasks: coreListTasks } = await import("../core/tasks.js");
      let tasks = coreListTasks(ctx.projectDir);
      tasks = tasks.filter((t) => t.status === "todo");
      if (input.type) tasks = tasks.filter((t) => t.type === input.type);
      if (input.tag && input.tag.length > 0) {
        tasks = tasks.filter(
          (t) => t.tags && input.tag!.every((tag) => t.tags!.includes(tag)),
        );
      }
      if (tasks.length === 0) {
        return {
          ok: false,
          error: {
            code: "NO_TASKS_AVAILABLE",
            message: "No tasks available to claim",
          },
        };
      }
      return {
        ok: true,
        data: tasks[0],
        steps: ["Dry run: task would be claimed"],
      };
    }

    // Delegate to the atomic claim primitive for serialized, race-safe claiming.
    const claimed = (await import("../core/tasks.js")).claimNextTaskAtomic(
      ctx.projectDir,
      {
        type: input.type,
        user: input.user,
        tag: input.tag,
        author: ctx.userId,
      },
    );

    if (!claimed) {
      return {
        ok: false,
        error: {
          code: "NO_TASKS_AVAILABLE",
          message: "No tasks available to claim",
        },
      };
    }

    return { ok: true, data: claimed };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "CLAIM_TASK_ERROR",
        message: err instanceof Error ? err.message : "Failed to claim task",
      },
    };
  }
}

export async function addComment(
  ctx: OperationContext,
  input: AddCommentInputType,
): Promise<OperationResult<TaskComment>> {
  try {
    const { addComment: coreAddComment } = await import("../core/comments.js");
    const comment = await coreAddComment(
      ctx.projectDir,
      input.id,
      input.author,
      input.text,
    );
    return { ok: true, data: comment };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "ADD_COMMENT_ERROR",
        message: err instanceof Error ? err.message : "Failed to add comment",
      },
    };
  }
}

export async function attachFile(
  ctx: OperationContext,
  input: AttachFileInputType,
): Promise<OperationResult<FileInfo>> {
  try {
    const { saveFile, validateFilename } = await import("../core/files.js");
    const buffer = Buffer.from(input.contentB64, "base64");
    // Gate BEFORE saveFile — reject manifest files, invalid extensions, oversized uploads
    const validation = validateFilename(input.filename, buffer.length);
    if (!validation.valid) {
      return {
        ok: false,
        error: { code: validation.errorCode, message: validation.errorMessage },
      };
    }
    const info = saveFile(ctx.projectDir, input.id, input.filename, buffer);
    return { ok: true, data: info };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "ATTACH_FILE_ERROR",
        message: err instanceof Error ? err.message : "Failed to attach file",
      },
    };
  }
}

export async function exportPrompt(
  ctx: OperationContext,
  input: ExportPromptInputType,
): Promise<OperationResult<string>> {
  try {
    const {
      listTasks: coreListTasks,
      renderTaskForAgent,
      findTaskFilePath,
      readTaskFile,
    } = await import("../core/tasks.js");
    const { listComments } = await import("../core/comments.js");
    const { listFiles } = await import("../core/files.js");

    if (input.id) {
      const filePath = findTaskFilePath(ctx.projectDir, input.id);
      if (!filePath) {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${input.id}`,
          },
        };
      }
      const task = readTaskFile(filePath);
      if (!task) {
        return {
          ok: false,
          error: {
            code: "TASK_READ_ERROR",
            message: `Failed to read task: ${input.id}`,
          },
        };
      }
      const comments = listComments(ctx.projectDir, input.id);
      const files = listFiles(ctx.projectDir, input.id);
      const rendered = renderTaskForAgent(
        task,
        filePath,
        comments,
        files,
        ctx.projectDir,
      );
      return { ok: true, data: rendered };
    }

    if (input.ids && input.ids.length > 0) {
      const results: string[] = [];
      for (const id of input.ids) {
        const filePath = findTaskFilePath(ctx.projectDir, id);
        if (!filePath) continue;
        const task = readTaskFile(filePath);
        if (!task) continue;
        const comments = listComments(ctx.projectDir, id);
        const files = listFiles(ctx.projectDir, id);
        results.push(
          renderTaskForAgent(task, filePath, comments, files, ctx.projectDir),
        );
      }
      return { ok: true, data: results.join("\n\n") };
    }

    // Export all tasks
    const tasks = coreListTasks(ctx.projectDir);
    const results: string[] = [];
    for (const task of tasks) {
      const filePath = findTaskFilePath(ctx.projectDir, task.id);
      if (!filePath) continue;
      const comments = listComments(ctx.projectDir, task.id);
      const files = listFiles(ctx.projectDir, task.id);
      results.push(
        renderTaskForAgent(task, filePath, comments, files, ctx.projectDir),
      );
    }
    return { ok: true, data: results.join("\n\n") };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "EXPORT_PROMPT_ERROR",
        message: err instanceof Error ? err.message : "Failed to export prompt",
      },
    };
  }
}

// Verify task uses the CLI verify command
// Semaphore ensures only one verify runs at a time (spec §5.9)
let verifyTail: Promise<unknown> = Promise.resolve();
function withVerifySemaphore<T>(fn: () => Promise<T>): Promise<T> {
  const run = verifyTail.then(fn, fn);
  verifyTail = run.catch(() => undefined);
  return run;
}

export async function verifyTaskOp(
  ctx: OperationContext,
  input: VerifyTaskInputType,
): Promise<OperationResult<unknown>> {
  return withVerifySemaphore(async () => {
    const { verifyTask, addVerifySystemComment } = await import(
      "../commands/verify.js"
    );
    const timeoutMs = input.timeoutMs ?? 60_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();

    try {
      const result = await verifyTask(ctx.projectDir, input.id, {
        url: input.url,
        signal: ac.signal,
      } as { json?: boolean; url?: string; signal?: AbortSignal });
      await addVerifySystemComment(ctx.projectDir, input.id, result);
      return { ok: true, data: result };
    } catch (err) {
      const ve = err instanceof Error && "code" in err
        ? err as { code: string; message: string; suggestion?: string }
        : null;
      if (ve) {
        return { ok: false, error: { code: ve.code, message: ve.message, suggestion: ve.suggestion } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "VERIFY_TIMEOUT" || ac.signal.aborted) {
        return {
          ok: false,
          error: {
            code: "VERIFY_TIMEOUT",
            message: `Verification timed out after ${input.timeoutMs}ms`,
            suggestion: "Increase timeoutMs or check that the app is running.",
          },
        };
      }
      return { ok: false, error: { code: "VERIFY_TASK_ERROR", message: msg } };
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function pushTasks(
  ctx: OperationContext,
  input: PushTasksInputType,
): Promise<OperationResult<unknown>> {
  try {
    const { push } = await import("../commands/push.js");
    const result = await push(ctx.projectDir, {
      workspace: input.workspace,
      keepLocalFiles: input.keepLocalFiles,
      dryRun: input.dryRun,
    });
    return { ok: true, data: result };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "PUSH_TASKS_ERROR",
        message: err instanceof Error ? err.message : "Failed to push tasks",
      },
    };
  }
}
