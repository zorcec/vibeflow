/**
 * MCP Operations Layer
 *
 * Thin wrappers over core functions that MCP tools call.
 * These operations handle context resolution (projectDir, mode, userId)
 * and delegate to the existing core functions.
 */
import { z } from "zod";
import type {
  Task,
  TaskComment,
  TaskLink,
  TaskLinkType,
} from "../core/types.js";
import {
  TASK_LINK_TYPES,
  TASK_STATUSES,
  type TaskStatus,
} from "../core/types.js";
import type { FileInfo } from "../core/files.js";
import { resolve, basename } from "node:path";
import { getCurrentBranch, getProjectName } from "./config.js";
import { getGitUser } from "./git-user.js";

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

// ── Dry run ────────────────────────────────────────────────────────────────

/**
 * A dry run is requested by EITHER the operation context (HTTP/SDK callers)
 * or the per-call tool input. Reading only ctx.dryRun let the MCP tools
 * advertise a `dryRun` input that was silently ignored, so a preview
 * performed a real write. Both sources must be honoured.
 */
export function isDryRun(
  ctx: OperationContext,
  input: { dryRun?: boolean },
): boolean {
  return ctx.dryRun === true || input.dryRun === true;
}

// ── Schemas ────────────────────────────────────────────────────────────────

export const ListTasksInput = z.object({
  // SAFETY: TASK_STATUSES is canonical; z.enum needs mutable tuple
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional(),
  type: z
    .enum(["Task", "Bug", "Feature", "Enhancement", "Research"])
    .optional(),
  user: z.string().optional(),
  tag: z.array(z.string()).optional(),
  limit: z.number().min(0).default(5),
  fields: z.array(z.string()).optional(),
  /**
   * Include child tasks. Default false: only ROOT tasks are listed, matching
   * the board, where a child is rendered inside its parent's card rather than
   * as a peer. See `isChildTask` in ./tasks.js.
   */
  children: z.boolean().default(false),
});
export type ListTasksInputType = z.infer<typeof ListTasksInput>;

export const GetTaskInput = z.object({
  id: z.string().min(1),
  fields: z.array(z.string()).optional(),
});
export type GetTaskInputType = z.infer<typeof GetTaskInput>;

// No input by design: the project root is resolved once at server startup
// (ctx.projectDir) and is never a per-call parameter — see getProject below.
export const GetProjectInput = z.object({});
export type GetProjectInputType = z.infer<typeof GetProjectInput>;

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
  // Optional explicit ordering key; core auto-assigns one when omitted.
  sortKey: z.string().optional(),
  // Optional parent task id (full id or unique prefix); links the new task
  // under it as a child.
  parent: z.string().min(1).optional(),
  // Preview only — never writes a task file. Present so the manifest's claim
  // that every mutating tool exposes `dryRun` is true for create_task too.
  dryRun: z.boolean().default(false),
});
export type CreateTaskInputType = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  id: z.string().min(1),
  // SAFETY: TASK_STATUSES is a readonly tuple; z.enum requires a mutable tuple type.
  status: z.enum(TASK_STATUSES as unknown as [string, ...string[]]).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  branch: z.string().optional(),
  comment: z.string().optional(),
  commitMessage: z.string().optional(),
  // Verification verdict (parity with the CLI's --set-verify / --verify-reason):
  // "pass" => verified=true (green badge), "fail" => verified=false (amber
  // badge, the review gate rejects it), "cannot" => verified=absent (no badge)
  // and REQUIRES verifyReason, which is recorded in the task's activity.
  // Omitting the field leaves any stored verdict untouched. `vibeflow verify`
  // never writes this flag — only the agent does, and review-gate.ts Gate 4
  // requires a verdict that lets the task through on the review transition.
  setVerify: z.enum(["pass", "fail", "cannot"]).optional(),
  verifyReason: z.string().optional(),
  dryRun: z.boolean().default(false),
  // Replace semantics for the task's links (matches the HTTP PATCH route):
  // the array becomes the full link set and an empty array clears every link.
  // Validated in updateTask against the post-replace state.
  links: z
    .array(
      z.object({
        taskId: z.string().min(1),
        // SAFETY: TASK_LINK_TYPES is a readonly tuple; z.enum requires a mutable tuple type.
        type: z.enum(
          TASK_LINK_TYPES as unknown as [TaskLinkType, ...TaskLinkType[]],
        ),
      }),
    )
    .optional(),
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
  // Named `comment`, not `text`: the CLI flag is `--comment` and update_task
  // already uses `comment`, so one concept must not have two names.
  comment: z.string().min(1),
  author: z.enum(["agent", "user"]).default("agent"),
  dryRun: z.boolean().default(false),
});
export type AddCommentInputType = z.infer<typeof AddCommentInput>;

export const AttachFileInput = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  contentB64: z.string().min(1),
  dryRun: z.boolean().default(false),
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
  // Preview only — never writes a task file and never launches a browser.
  // verify_task mutates (it adds a system comment and records a verdict), so
  // without this input the manifest's claim that every mutating tool exposes
  // a `dryRun` was false for this one tool.
  dryRun: z.boolean().default(false),
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
): Promise<
  OperationResult<{ tasks: Task[]; total: number; hiddenChildren: number }>
> {
  try {
    // Dynamic import to avoid circular dependencies
    const { listTasks: coreListTasks, isChildTask } = await import(
      "../core/tasks.js"
    );
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

    // OWNER DECISION: list ROOT tasks only unless asked otherwise. A child
    // belongs to its parent, so listing it as a peer would contradict the
    // board, which renders it inside the parent's card. Mirrors the CLI's
    // `tasks` / `--children` behaviour.
    const hiddenChildren = input.children
      ? 0
      : tasks.filter(isChildTask).length;
    if (!input.children) {
      tasks = tasks.filter((t) => !isChildTask(t));
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

    return { ok: true, data: { tasks, total, hiddenChildren } };
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
    const { findTaskFilePath, readTaskFile, resolveTaskId } = await import(
      "../core/tasks.js"
    );
    // Accept a full id OR a prefix, like the CLI's `--get` does. Without this
    // the MCP path was exact-match only and every prefix length returned
    // TASK_NOT_FOUND.
    const id = resolveTaskId(ctx.projectDir, input.id);
    const filePath = findTaskFilePath(ctx.projectDir, id);
    if (!filePath) {
      return {
        ok: false,
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task not found: ${id}`,
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
          message: `Failed to read task: ${id}`,
        },
      };
    }

    // Derive relations (parent/children/other) for ergonomic MCP access.
    const { taskRelations } = await import("../core/task-links.js");
    const { listTasks: coreListTasks } = await import("../core/tasks.js");
    const allTasks = coreListTasks(ctx.projectDir);
    const relations = taskRelations(allTasks, task.id);
    const data: Record<string, unknown> = { ...task, ...relations };

    // Apply field selection
    if (input.fields && input.fields.length > 0) {
      const fieldSet = new Set(input.fields);
      const filtered: Record<string, unknown> = {};
      for (const key of Object.keys(data)) {
        if (fieldSet.has(key)) {
          filtered[key] = data[key];
        }
      }
      // SAFETY: filtered contains a subset of keys; partial Task is still structurally valid for JSON serialization
      return { ok: true, data: filtered as unknown as Task };
    }

    // SAFETY: data is a Task with added derived relation fields; structurally compatible for JSON serialization
    return { ok: true, data: data as unknown as Task };
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

/**
 * The project the server is attached to. `root` is always the startup-resolved
 * ctx.projectDir — accepting a root as input would break Model 1's invariant
 * that a tool can only *discover* the project, never retarget the server.
 */
export interface ProjectInfo {
  root: string;
  name: string;
  branch: string | null;
  mode: "local" | "saas";
}

export async function getProject(
  ctx: OperationContext,
  _input?: GetProjectInputType,
): Promise<OperationResult<ProjectInfo>> {
  // Mirror W2's `initialize` (mcp/server.ts): resolve once, then derive
  // name/branch from the same absolute path, so the handshake announcement
  // and this tool always report identical values.
  const abs = resolve(ctx.projectDir);
  return {
    ok: true,
    data: {
      root: abs,
      name: getProjectName(abs),
      branch: getCurrentBranch(abs),
      mode: ctx.mode,
    },
  };
}

export async function createTask(
  ctx: OperationContext,
  input: CreateTaskInputType,
): Promise<OperationResult<Task>> {
  try {
    // Resolve an optional parent (full id or unique prefix) to a parent link,
    // matching the wording the --set-parent path emits. A task being created
    // has no id/links/descendants yet, so self-link, duplicate and cycle are
    // structurally impossible; a dangling target is the only rejection.
    let links: TaskLink[] | undefined;
    if (input.parent) {
      const { listTasks: coreListTasks, matchesIdOrPrefix } = await import(
        "../core/tasks.js"
      );
      // One store scan: matchesIdOrPrefix IS the resolution rule, applied to
      // the list already loaded. resolveTaskId() re-ran listTasks just to
      // pick the first match from the same directory.
      const allTasks = coreListTasks(ctx.projectDir);
      const parentTask = allTasks.find((t) =>
        matchesIdOrPrefix(t, input.parent!),
      );
      if (!parentTask) {
        return {
          ok: false,
          error: {
            code: "CREATE_TASK_ERROR",
            message: `Parent task not found: ${input.parent}`,
          },
        };
      }
      links = [{ taskId: parentTask.id, type: "parent" }];
    }

    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: {
          id: "dry-run",
          title: input.title,
          description: input.description ?? "",
          status: input.status as TaskStatus,
          selector: input.selector,
          created: new Date().toISOString(),
          ...(links ? { links } : {}),
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
      sortKey: input.sortKey,
      ...(links ? { links } : {}),
      // Same identity source as the CLI and the board so agent-created tasks
      // match human-created ones.
      author: ctx.userId ?? getGitUser(ctx.projectDir).name,
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
    const { findTaskFilePath, readTaskFile, resolveTaskId } = await import(
      "../core/tasks.js"
    );
    // Accept a full id OR a prefix, like the CLI's `--edit` does; the resolved
    // id drives the lookup, the write and the error wording below.
    const id = resolveTaskId(ctx.projectDir, input.id);
    const filePath = findTaskFilePath(ctx.projectDir, id);
    const existingTask = filePath ? readTaskFile(filePath) : null;
    if (!existingTask) {
      return {
        ok: false,
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task not found: ${id}`,
        },
      };
    }

    // Attestation is resolved ONCE, before the review gate and before any
    // write, exactly as the CLI's --edit path does (src/index.ts). The CLI
    // consulted it unconditionally; the MCP path skipped it entirely, so
    // `setVerify:"cannot"` with no reason and a bare `verifyReason` were both
    // accepted here and recorded nothing. The resolution is also the only
    // place a verdict becomes a stored value from here down.
    const { resolveVerifyAttestation } = await import(
      "./verify-attestation.js"
    );
    const attestation = resolveVerifyAttestation({
      setVerify: input.setVerify,
      verifyReason: input.verifyReason,
    });
    if (!attestation.ok) {
      return {
        ok: false,
        error: { code: attestation.code, message: attestation.message },
      };
    }

    // Gate: review transition check (runs before any writes, including dry-run)
    if (input.status === "review") {
      const { loadSettings } = await import("../core/settings.js");
      const { checkReviewTransition } = await import("../core/review-gate.js");
      const settings = loadSettings(ctx.projectDir);
      const gate = checkReviewTransition(
        ctx.projectDir,
        id,
        {
          comment: input.comment,
          commitMessage: input.commitMessage,
          // Gate 3 (BRANCH_REQUIRED) reads the branch THIS transition carries.
          // It was never passed, so with createBranch ON a review transition
          // was refused even when the input supplied `branch` — a
          // requested-but-ignored input, the same bug class as the dryRun one.
          // The CLI has passed branch: opts.branch since before MCP existed
          // (index.ts).
          branch: input.branch,
          verifyVerdict: attestation.verdict,
          verifyReason: input.verifyReason,
        },
        { projectDir: ctx.projectDir, settings },
      );
      if (!gate.ok) {
        return {
          ok: false,
          error: {
            code: gate.code,
            message: gate.message,
            suggestion: gate.suggestion,
          },
        };
      }
    }

    // Research tasks cannot carry a verification verdict — same rule as
    // the review gate, but applied to standalone setVerify too.
    if (attestation.verdict) {
      const { isResearchType: checkResearch } = await import(
        "../core/tasks.js",
      );
      if (checkResearch(existingTask.type)) {
        return {
          ok: false,
          error: {
            code: "RESEARCH_VERIFY_NOT_ALLOWED",
            message:
              "A Research task cannot carry a verification verdict \u2014 it has no annotated UI to verify",
            suggestion:
              "Drop --set-verify; submit the Research task with its .md report instead",
          },
        };
      }
    }

    // Links: replace semantics (parity with the HTTP PATCH route). Validated
    // against the post-replace state using the same helpers and wording as
    // --set-parent; rejected before any write (including dry-run).
    let linksUpdate: TaskLink[] | undefined;
    const linksProvided = input.links !== undefined;
    if (linksProvided) {
      const { buildUpdateLinks } = await import("../core/task-links.js");
      const { listTasks: coreListTasks } = await import("../core/tasks.js");
      const linksResult = buildUpdateLinks({
        allTasks: coreListTasks(ctx.projectDir),
        taskId: existingTask.id,
        incoming: input.links!,
      });
      if (!linksResult.ok) {
        return {
          ok: false,
          error: { code: "UPDATE_TASK_ERROR", message: linksResult.reason },
        };
      }
      linksUpdate = linksResult.links;
    }

    // Dry-run: return preview (after gate check so would-be failures are reported)
    if (isDryRun(ctx, input)) {
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
    if (linksProvided) updates.links = linksUpdate;

    // Verify reset on in-progress (parity with CLI edit path). Clear the flag
    // (omit the key) instead of writing `false`, so the tri-state survives:
    // true = verified correct, false = verified WRONG, absent = not assessed.
    if (input.status === "in-progress") {
      updates.verified = undefined;
    }

    // Verification verdict, applied after the reset-on-claim above (parity with
    // the CLI): the reset is the default for a claim without a verdict, an
    // explicit verdict in the same call is what gets recorded, and "cannot"
    // writes ABSENCE (no badge) — distinct from "fail", which stores false (the
    // completed verdict that the task is WRONG).
    if (attestation.verdict) {
      updates.verified = attestation.clear ? undefined : attestation.value;
    }

    // Author attribution on status changes (parity with the CLI --edit path):
    // claiming sets the current identity; other transitions backfill only.
    if (input.status) {
      if (input.status === "in-progress" || !existingTask.author) {
        updates.author = ctx.userId ?? getGitUser(ctx.projectDir).name;
      }
    }

    const task = coreUpdateTask(ctx.projectDir, id, updates);
    if (!task) {
      return {
        ok: false,
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task not found: ${id}`,
        },
      };
    }

    // Comment is added only after all gates pass (same ordering as CLI)
    if (input.comment) {
      const { addComment } = await import("../core/comments.js");
      addComment(ctx.projectDir, id, "agent", input.comment);
    }

    // A "cannot" verdict's reason is recorded in the task's activity (system
    // comment) so the detail panel shows why the task carries no verdict. Only
    // when the verdict and reason both survived the gate.
    if (attestation.verdict === "cannot" && attestation.reason) {
      const { addComment } = await import("../core/comments.js");
      addComment(
        ctx.projectDir,
        id,
        "agent",
        `**Cannot verify:** ${attestation.reason}`,
        undefined,
        "system",
      );
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

    return {
      ok: true,
      data: task,
      steps: steps.length > 0 ? steps : undefined,
    };
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
    if (isDryRun(ctx, input)) {
      const { listTasks: coreListTasks, isChildTask } = await import(
        "../core/tasks.js"
      );
      let tasks = coreListTasks(ctx.projectDir);
      tasks = tasks.filter((t) => t.status === "todo");
      // Parity with the atomic path: never a child. The root is the unit of work.
      tasks = tasks.filter((t) => !isChildTask(t));
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
        // OWNER DECISION: never claim a child. The root carries its children.
        rootsOnly: true,
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
    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: {
          id: "dry-run",
          author: input.author,
          text: input.comment,
          createdAt: new Date().toISOString(),
        },
        steps: ["Dry run: comment would be added"],
      };
    }
    const { addComment: coreAddComment } = await import("../core/comments.js");
    const comment = await coreAddComment(
      ctx.projectDir,
      input.id,
      input.author,
      input.comment,
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
    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: {
          name: basename(input.filename),
          size: buffer.length,
          url: `/api/tasks/${input.id}/files/${encodeURIComponent(basename(input.filename))}`,
        },
        steps: ["Dry run: file would be attached"],
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
      const allTasks = coreListTasks(ctx.projectDir);
      const rendered = renderTaskForAgent(
        task,
        filePath,
        comments,
        files,
        ctx.projectDir,
        allTasks,
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
        const allTasks = coreListTasks(ctx.projectDir);
        results.push(
          renderTaskForAgent(
            task,
            filePath,
            comments,
            files,
            ctx.projectDir,
            allTasks,
          ),
        );
      }
      return { ok: true, data: results.join("\n\n") };
    }

    // Export all tasks
    const allTasks = coreListTasks(ctx.projectDir);
    const results: string[] = [];
    for (const task of allTasks) {
      const filePath = findTaskFilePath(ctx.projectDir, task.id);
      if (!filePath) continue;
      const comments = listComments(ctx.projectDir, task.id);
      const files = listFiles(ctx.projectDir, task.id);
      results.push(
        renderTaskForAgent(
          task,
          filePath,
          comments,
          files,
          ctx.projectDir,
          allTasks,
        ),
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
  // Dry run FIRST, before the semaphore and before `../commands/verify.js` is
  // imported: the engine shells out to a browser, and a preview must not do
  // that work. Everything below this line (semaphore, timer, the E_NOT_FOUND /
  // E_NO_BASELINE / VERIFY_TIMEOUT refusal paths) behaves exactly as before.
  if (isDryRun(ctx, input)) {
    const { findTaskByIdOrPrefix } = await import("../core/tasks.js");
    const task = findTaskByIdOrPrefix(ctx.projectDir, input.id);
    if (!task) {
      // The SAME refusal the real path raises: commands/verify.ts throws
      // VerifyError("E_NOT_FOUND", `Task not found: ${taskId}`, …) when
      // findTaskFilePath misses. A preview that answered ok:true with
      // data:null for an unresolvable id told the client the id was fine —
      // and updateTask's preview already refused the same case.
      return {
        ok: false,
        error: {
          code: "E_NOT_FOUND",
          message: `Task not found: ${input.id}`,
          suggestion: "Run 'vibeflow tasks' to see available task IDs.",
        },
      };
    }
    return {
      ok: true,
      data: task,
      steps: ["Dry run: verification would run"],
    };
  }
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
      const ve =
        err instanceof Error && "code" in err
          ? (err as { code: string; message: string; suggestion?: string })
          : null;
      if (ve) {
        return {
          ok: false,
          error: {
            code: ve.code,
            message: ve.message,
            suggestion: ve.suggestion,
          },
        };
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
    // push() is typed Promise<PushResult | void> and returns void on early
    // exits (nothing to push, local mode, missing login). Normalise to an
    // object so the success envelope is always serialisable —
    // JSON.stringify(undefined) is undefined, which would violate the MCP
    // TextContent contract (text: string).
    return { ok: true, data: result ?? {} };
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
