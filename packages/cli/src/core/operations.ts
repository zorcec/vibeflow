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
  compareTasksByPriorityThenCreated,
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

/**
 * A note about work that is NOT a failure but the caller must know about: a
 * dry-run preview ("nothing was written"), a post-review auto-commit report,
 * "there was nothing to push".
 *
 * This is the same `{code, message}` shape the CLI puts on its `notices`
 * array, so one parser reads both surfaces. It is deliberately NOT the online
 * board's `warning` passthrough, which is a bare server-provided STRING.
 */
export interface OperationNotice {
  code: string;
  message: string;
}

/** The refusal half of `OperationResult`, named so a helper can return one. */
export interface OperationError {
  code: string;
  message: string;
  retryable?: boolean;
  suggestion?: string;
}

export interface OperationResult<T> {
  ok: boolean;
  data?: T;
  error?: OperationError;
  /**
   * Named `steps` INTERNALLY and on purpose: it is this layer's own vocabulary
   * and several call sites read it. The MCP wire key it serialises to is
   * `notices` (see `successPayload` in src/mcp/server.ts) — the rename is a
   * wire change only, so the two surfaces say `notices` to a consumer while
   * this file keeps the name it always had.
   */
  steps?: OperationNotice[];
}

// ── Task resolution (the one existence check) ─────────────────────────────

/**
 * The ONE `TASK_NOT_FOUND` recovery text, shared by every tool that returns
 * that code. It used to exist on `get_task` alone, so the same code carried two
 * different suggestions depending on which tool refused — a client could not
 * learn the recovery once and apply it everywhere. One constant is the fix.
 */
export const TASK_NOT_FOUND_SUGGESTION =
  "List the board to get a real id (list_tasks on MCP, 'vibeflow tasks' on the CLI) — a full id or a unique prefix both resolve.";

/**
 * The `suggestion` `verify_task` falls back to when the verify engine's own
 * `VerifyError` carries none. It is a fallback, not a per-code table: the
 * engine's codes are NOT renamed and its own text always wins. Without it the
 * passthrough in `verifyTaskOp` forwarded the absence, and the README's
 * "every tool-level refusal carries a `suggestion`" had a reachable exception
 * (`E_NO_SELECTOR`, `E_AUTH_EXPIRED`, `E_AUTH_CORRUPT`, `E_APP_NOT_RUNNING`,
 * `E_NAVIGATION_FAILED`, `E_CANCELLED`).
 */
export const VERIFY_ERROR_SUGGESTION =
  "The verify engine refused before it could check anything — read `message` for the input it is missing, supply it (re-annotate the task if that input is not one you can set here), then run verify_task again";

export type TaskResolution =
  | { ok: true; id: string; filePath: string; task: Task }
  | { ok: false; error: OperationError };

/**
 * Resolve a task id to the task it names, or refuse `TASK_NOT_FOUND`.
 *
 * THE existence check for every task-scoped MCP mutation. It exists because
 * three tools each rolled their own (or none at all) and the store is
 * append-only enough that a mistake is not self-healing: `add_comment` wrote a
 * GHOST task file for an unknown id, `attach_file` wrote a file under
 * `.vibeflow/tasks/files/<id>/`, and each answered `ok:true`, so the agent was
 * told the write happened and had nothing to recover from.
 *
 * Why a fourth tool cannot forget it:
 *  1. id resolution already lived in two places (`getTask`, `updateTask`) with
 *     the same prefix-tolerant rule — this helper is that rule, lifted out
 *     rather than reinvented, so there is one implementation of "what id does
 *     this mean", not three;
 *  2. every mutating tool takes the RESOLVED `id` from here, never the raw
 *     input, so a tool cannot even name a path it has not resolved;
 *  3. `tests/e2e/mcp-mutation-refusal-guard.test.ts` enumerates the manifest's
 *     task-write tools and sweeps each with an id that cannot exist, so a NEW
 *     mutating tool is covered by the manifest sweep the day it is added —
 *     a fourth tool cannot be added without the guard seeing it.
 */
export async function resolveTaskOrRefusal(
  ctx: OperationContext,
  idOrPrefix: string,
): Promise<TaskResolution> {
  const { findTaskFilePath, readTaskFile, resolveTaskId } = await import(
    "../core/tasks.js"
  );
  // Accept a full id OR a prefix, like the CLI's `--get`/`--edit` do.
  const id = resolveTaskId(ctx.projectDir, idOrPrefix);
  const filePath = findTaskFilePath(ctx.projectDir, id);
  if (!filePath) {
    return {
      ok: false,
      error: {
        code: "TASK_NOT_FOUND",
        message: `Task not found: ${id}`,
        suggestion: TASK_NOT_FOUND_SUGGESTION,
      },
    };
  }
  const task = readTaskFile(filePath);
  if (!task) {
    // The file is there but unreadable — a different problem with a different
    // fix, so it is a different code. Kept distinct from TASK_NOT_FOUND by
    // every task-scoped tool so one consumer can branch on it.
    return {
      ok: false,
      error: {
        code: "TASK_READ_ERROR",
        message: `Failed to read task: ${id}`,
        suggestion:
          "The task file exists but did not parse — check it is valid JSON, or re-create the task",
      },
    };
  }
  return { ok: true, id, filePath, task };
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
  // DESCRIBED, not just typed: `tools/list` is the ONLY place a client can
  // read this before the SDK's input validation refuses the call with
  // `MCP error -32602: … at limit`, which is raised before any handler runs and
  // carries no `suggestion`. See the field-description note below.
  limit: z
    .number()
    .min(0)
    .default(5)
    .describe(
      "How many tasks to return. 0 (or less) means no limit. A negative value is refused by input validation before the tool runs.",
    ),
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
  // Descriptions are load-bearing on the fields agents most often get wrong:
  // see ListTasksInput.limit for why `tools/list` is the only place they can be
  // read before the SDK refuses the call.
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one. Get a real id from list_tasks; an id that matches nothing is refused with TASK_NOT_FOUND.",
    ),
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
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, of the task to update. An id that matches nothing is refused with TASK_NOT_FOUND and changes nothing.",
    ),
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
  setVerify: z
    .enum(["pass", "fail", "cannot"])
    .optional()
    .describe(
      "Your verification verdict: \"pass\" = the task IS implemented correctly (required for an annotated task at review), \"fail\" = it is NOT (the review gate blocks it), \"cannot\" = unverifiable here, which REQUIRES verifyReason. Omit to leave any stored verdict untouched.",
    ),
  verifyReason: z
    .string()
    .optional()
    .describe(
      "Why the task cannot be verified. REQUIRED with setVerify:\"cannot\", and refused as E_USAGE on its own — a reason belongs to a \"cannot\" verdict.",
    ),
  dryRun: z.boolean().default(false),
  // MERGE semantics, identical to the CLI's `--relates` / `--blocks` and to
  // `addLinks` below: every listed pair is ADDED, a pair already present is a
  // no-op (idempotent), and a link you leave out stays exactly where it is.
  // This is a deliberate change from the old REPLACE behaviour, which made a
  // partial array silently DELETE every link it omitted — the single most
  // destructive thing an MCP agent could do by accident.
  // `links: []` is refused (E_USAGE) rather than read as "clear": under merge an
  // empty array is almost certainly a client that still believes replace
  // semantics apply, and silently doing nothing would be the worst outcome. To
  // clear, say so explicitly with `clearLinks: true`.
  // Omit the field entirely and links are untouched.
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
    .optional()
    .describe(
      "ADD the listed links without touching the rest (merge, same as the CLI's --relates/--blocks). A pair already present is a no-op. `links: []` is REFUSED — use clearLinks:true to clear. Combining `links` with `addLinks` merges their union once.",
    ),
  // CLEAR: drop the WHOLE link set in one call. Only `true` acts; `false` (or
  // an absent field) leaves links alone, so a client that always sends the flag
  // cannot wipe links by omission.
  // Combinable with the other three styles, and the order is fixed and
  // deterministic: clearLinks first, then the `links`/`addLinks` merge, then
  // `removeLinks` — so "start over and set exactly these, minus these" reads
  // the way it is written. `links: []` remains refused regardless.
  clearLinks: z
    .boolean()
    .optional()
    .describe(
      "Remove EVERY link from the task. Applied BEFORE the merge: clearLinks -> (links + addLinks) -> removeLinks. `true` clears; `false` or absent is a no-op.",
    ),
  // ADDITIVE: merge semantics, mirroring the CLI's `--relates` / `--blocks` and
  // the CLI's `--set-parent` (surgical, keeps every other link). A link already
  // present is a no-op, so the call is idempotent. Same meaning as `links`; when
  // both are sent they are merged as a union in ONE pass, never applied twice.
  addLinks: z
    .array(
      z.object({
        taskId: z.string().min(1),
        // SAFETY: as above — readonly tuple widened for z.enum.
        type: z.enum(
          TASK_LINK_TYPES as unknown as [TaskLinkType, ...TaskLinkType[]],
        ),
      }),
    )
    .optional()
    .describe(
      "ADD links without touching the rest (merge). Same semantics as `links` — sending both merges their union once. Use clearLinks:true to drop the whole set.",
    ),
  // SUBTRACTIVE: removes exactly the listed taskId+type pairs and leaves every
  // other link alone. A pair that is not present is a no-op. Applied LAST, after
  // clearLinks and after the links/addLinks merge.
  removeLinks: z
    .array(
      z.object({
        taskId: z.string().min(1),
        // SAFETY: as above — readonly tuple widened for z.enum.
        type: z.enum(
          TASK_LINK_TYPES as unknown as [TaskLinkType, ...TaskLinkType[]],
        ),
      }),
    )
    .optional()
    .describe(
      "REMOVE the listed links without touching the rest. Applied after clearLinks and after the links/addLinks merge.",
    ),
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
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, of the task to comment on. An id that matches nothing is refused with TASK_NOT_FOUND; no task is created.",
    ),
  // Named `comment`, not `text`: the CLI flag is `--comment` and update_task
  // already uses `comment`, so one concept must not have two names.
  comment: z
    .string()
    .min(1)
    .describe(
      "The comment body — what changed, what you verified, what a reviewer should know. Required and non-empty: an empty body is refused by input validation before the tool runs.",
    ),
  author: z.enum(["agent", "user"]).default("agent"),
  dryRun: z.boolean().default(false),
});
export type AddCommentInputType = z.infer<typeof AddCommentInput>;

export const AttachFileInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, of the task to attach to. An id that matches nothing is refused with TASK_NOT_FOUND; no file is written.",
    ),
  filename: z
    .string()
    .min(1)
    .describe(
      "Bare filename, no directory part. The EXTENSION decides acceptance: a .md is what satisfies the research-report gate, and an unsupported extension is refused with UNSUPPORTED_FILE_TYPE.",
    ),
  contentB64: z
    .string()
    .min(1)
    .describe(
      "The file content, base64-encoded (not raw bytes, and not a path to read). Required: omitting it is refused by input validation before the tool runs.",
    ),
  dryRun: z.boolean().default(false),
});
export type AttachFileInputType = z.infer<typeof AttachFileInput>;

export const ExportPromptInput = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "A FULL task id to export — this tool matches ids EXACTLY, so a prefix is NOT resolved and is refused with TASK_NOT_FOUND. Omit it (or pass `ids`) to export the whole board.",
    ),
  // Real behaviour, stated because it differs from the other id-bearing tools:
  // no prefix resolution, and an id that matches nothing is SKIPPED rather than
  // refused (a list is best-effort), so the answer can name fewer tasks than
  // were asked for.
  ids: z
    .array(z.string())
    .optional()
    .describe(
      "FULL task ids to export, matched exactly. An id that matches no task is skipped rather than refused, so check that the rendered output names every id you asked for.",
    ),
  format: z.enum(["markdown", "json"]).default("markdown"),
});
export type ExportPromptInputType = z.infer<typeof ExportPromptInput>;

export const VerifyTaskInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Task id — a full id, or any unique prefix of one, resolved by the same shared rule every other task tool uses. An id that matches nothing is refused with E_NOT_FOUND (this tool runs the CLI verify engine, which has its own code), and every refusal it returns carries a `suggestion`.",
    ),
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

export const StartKanbanInput = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe(
      "Port to bind. Defaults to 3700, the same default as the `vibeflow serve` / `vibeflow kanban` commands. Ignored when the server is already running.",
    ),
  host: z
    .string()
    .optional()
    .describe(
      "Bind hostname. Defaults to localhost; use 0.0.0.0 to expose the board on the LAN (the tool then also returns a localhost URL). Ignored when the server is already running.",
    ),
  // The manifest's own rule (`tests/unit/mcp/parity.test.ts`): a tool that is
  // not readOnly must expose a preview. Starting the board is exactly the kind
  // of side effect an agent wants to check before committing a port.
  dryRun: z
    .boolean()
    .default(false)
    .describe(
      "Preview only: report the URLs and guide the server WOULD serve, and bind nothing. Never starts a process.",
    ),
});
export type StartKanbanInputType = z.infer<typeof StartKanbanInput>;

export const GetIntegrationGuideInput = z.object({});
export type GetIntegrationGuideInputType = z.infer<
  typeof GetIntegrationGuideInput
>;

/** True for a Node listen() EADDRINUSE failure, on the error or its `cause`. */
function isAddrInUse(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return true;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return (cause as { code?: unknown } | undefined)?.code === "EADDRINUSE";
}

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
        suggestion:
          "Check that <project> is a vibeflow store and readable (is there a .vibeflow/tasks directory?), then call list_tasks again",
      },
    };
  }
}

export async function getTask(
  ctx: OperationContext,
  input: GetTaskInputType,
): Promise<OperationResult<Task>> {
  try {
    // Existence check FIRST, from the one shared resolver — see
    // resolveTaskOrRefusal. get_task used to inline this, and add_comment /
    // attach_file had no equivalent, which is how a ghost task got written.
    const resolved = await resolveTaskOrRefusal(ctx, input.id);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { task } = resolved;

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
        suggestion:
          "Re-read the task with get_task; if the store is unreadable, check the task file under .vibeflow/tasks parses as JSON",
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
            // The code differs from the CLI's TASK_NOT_FOUND for the same
            // situation (pre-existing, and out of scope to change on a wire an
            // existing consumer may parse) — but the RECOVERY text must not
            // depend on which surface refused.
            suggestion: `The parent task does not exist — drop \`parent\` to create a root task, or pass an id from list_tasks (MCP) / 'vibeflow tasks' (CLI)`,
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
        steps: [{ code: "DRY_RUN", message: "Task would be created" }],
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
        suggestion:
          "Check the input against create_task's shape (title is required) and that the project directory is writable, then retry",
      },
    };
  }
}

export async function updateTask(
  ctx: OperationContext,
  input: UpdateTaskInputType,
): Promise<OperationResult<Task>> {
  try {
    // Existence check FIRST, from the one shared resolver. A task-scoped
    // mutation must never reach its write without this.
    const resolved = await resolveTaskOrRefusal(ctx, input.id);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { id, task: existingTask } = resolved;

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
        error: {
          code: attestation.code,
          message: attestation.message,
          suggestion: attestation.suggestion,
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
              "Drop the verdict \u2014 setVerify (MCP) or --set-verify (CLI) \u2014 and submit the Research task with its .md report attached via attach_file (MCP) or --report-file (CLI)",
          },
        };
      }
    }

    // Links: four ways to write them, applied in one fixed order.
    //
    // `clearLinks`  — drop the WHOLE set. The only way to clear.
    // `links`       — merge. Now the same thing the CLI's `--relates` /
    //                  `--blocks` do (and the same thing `addLinks` below
    //                  does), so the MCP surface matches the CLI.
    // `addLinks`    — merge. `links` and `addLinks` are folded into a union
    //                  and merged ONCE; sending both is not a double-apply.
    // `removeLinks` — subtract exactly the named taskId+type pairs.
    //
    // `links` used to REPLACE, which is why an agent sending a partial array
    // silently destroyed the parent and every other link it omitted. Merge is
    // the only safe default for a surface that is updated in pieces, so the
    // destructive case now has to be asked for by name (`clearLinks: true`).
    //
    // ORDER: clearLinks -> merge(links ∪ addLinks) -> removeLinks. Clear-then-
    // set in a single call is meaningful and deterministic ("start over with
    // exactly these, minus these"), and removeLinks-last means "except" can be
    // expressed even when the same call adds the link back.
    let linksUpdate: TaskLink[] | undefined;
    const linksProvided = input.links !== undefined;
    const addLinksProvided = input.addLinks !== undefined;
    const removeLinksProvided = input.removeLinks !== undefined;
    // Only `true` is an instruction. `clearLinks: false` (or absent) is a
    // no-op, so a client that always sends the flag cannot wipe links by
    // omission — the same "absent means untouched" rule as every other
    // optional field here.
    const clearLinksRequested = input.clearLinks === true;

    // `links: []` under merge means nothing was named, so honouring it as a
    // no-op would silently swallow a client that still believes replace
    // semantics apply — its links would survive a call it read as "clear
    // them". Refused, and the message names the field that DOES clear.
    if (linksProvided && input.links!.length === 0) {
      return {
        ok: false,
        error: {
          code: "E_USAGE",
          message:
            "`links: []` is refused \u2014 `links` now MERGES, so an empty array names no links and cannot mean \"clear\"",
          suggestion:
            "`links` and `addLinks` merge: listed pairs are added and everything else is kept. To remove EVERY link, send `clearLinks: true` (it applies before the merge, so it can be combined with `links`/`addLinks`/`removeLinks` in the same call). To remove specific links, use `removeLinks`. Omit the field entirely to leave links untouched.",
        },
      };
    }

    if (
      clearLinksRequested ||
      linksProvided ||
      addLinksProvided ||
      removeLinksProvided
    ) {
      const { buildAddLinks, buildRemoveLinks } = await import(
        "../core/task-links.js"
      );
      const { listTasks: coreListTasks } = await import("../core/tasks.js");
      let current = coreListTasks(ctx.projectDir);
      // Each helper validates against the state it is handed, so every pass
      // folds what the previous pass decided back into the board it re-reads.
      let next: TaskLink[] | undefined = existingTask.links ?? undefined;

      // 1. clearLinks: empty the base set BEFORE anything is folded in.
      if (clearLinksRequested) {
        next = undefined;
        current = current.map((t) =>
          t.id === existingTask.id ? { ...t, links: undefined } : t,
        );
      }

      // 2. merge `links` ∪ `addLinks` in a single buildAddLinks call — the
      // union is deduped there, so a pair named in both (or twice in one
      // array) is a no-op rather than a duplicate-parent refusal.
      const incoming = [...(input.links ?? []), ...(input.addLinks ?? [])];
      if (incoming.length > 0) {
        const added = buildAddLinks({
          allTasks: current,
          taskId: existingTask.id,
          incoming,
        });
        if (!added.ok)
          return {
            ok: false,
            error: {
              code: added.code,
              message: added.reason,
              suggestion:
                added.code === "TASK_NOT_FOUND"
                  ? TASK_NOT_FOUND_SUGGESTION
                  : "The link you asked to add was refused as invalid \u2014 fix what the message names and resend `links`/`addLinks`. Existing links are untouched by a refused add; to drop links use `removeLinks` (or `clearLinks: true` for all of them).",
            },
          };
        next = added.links;
        current = current.map((t) =>
          t.id === existingTask.id ? { ...t, links: next ?? [] } : t,
        );
      }

      // 3. removeLinks last: subtract exactly the named pairs, after the
      // merge, so "add X back except Y" is expressible.
      if (removeLinksProvided) {
        const removed = buildRemoveLinks({
          allTasks: current,
          taskId: existingTask.id,
          remove: input.removeLinks!,
        });
        if (!removed.ok)
          return {
            ok: false,
            error: {
              code: removed.code,
              message: removed.reason,
              suggestion: TASK_NOT_FOUND_SUGGESTION,
            },
          };
        next = removed.links;
      }
      linksUpdate = next;
    }

    // Dry-run: return preview (after gate check so would-be failures are reported)
    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: existingTask,
        steps: [{ code: "DRY_RUN", message: "Task would be updated" }],
      };
    }

    const { updateTask: coreUpdateTask } = await import("../core/tasks.js");
    const updates: Record<string, unknown> = {};
    if (input.status) updates.status = input.status;
    if (input.title) updates.title = input.title;
    if (input.description !== undefined)
      updates.description = input.description;
    if (input.branch) updates.branchName = input.branch;
    // Any of the four link styles that was provided. Guarding on
    // `linksProvided` alone would silently make clearLinks / addLinks /
    // removeLinks a no-op — the link set was computed above and must be
    // written whenever ANY style ran. `undefined` (no links left) still means
    // "clear": updateTask spreads the key over the stored task.
    if (
      clearLinksRequested ||
      linksProvided ||
      addLinksProvided ||
      removeLinksProvided
    )
      updates.links = linksUpdate;

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
          suggestion: TASK_NOT_FOUND_SUGGESTION,
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

    // Auto-commit after review transition (parity with CLI auto-commit path).
    // The codes are the CLI's own (`notices[].code`), so a consumer reading
    // either surface branches on the same string. The CLI emits no notice for
    // a commit that SUCCEEDED; the MCP tool always says which happened,
    // because here the notice is the only signal at all.
    const steps: OperationNotice[] = [];
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
          steps.push({
            code: "GIT_COMMITTED",
            message: commitResult.sha,
          });
        } else {
          steps.push({
            code: "GIT_COMMIT_FAILED",
            message: commitResult.error,
          });
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
        suggestion:
          "Re-read the task with get_task, then resend the edit; if it keeps failing, check the task file parses and the store is writable",
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
      // `user` is a documented ClaimNextTaskInput field, so the dry run
      // applies it exactly as the atomic path does (author identity match).
      if (input.user) tasks = tasks.filter((t) => t.author === input.user);
      if (input.tag && input.tag.length > 0) {
        tasks = tasks.filter(
          (t) => t.tags && input.tag!.every((tag) => t.tags!.includes(tag)),
        );
      }
      // listTasks() returns files in readdir order, which is NOT the claim
      // order (filenames are random ids). Sort with the SAME comparator the
      // atomic path uses inside its lock, so the preview names the task the
      // real call will actually claim.
      tasks.sort(compareTasksByPriorityThenCreated);
      if (tasks.length === 0) {
        // A valid filter that matched nothing is the SAME situation as an
        // empty board, and the dry run must not disagree with the real path:
        // both answer "nothing was claimed" as a success with a null payload.
        return { ok: true };
      }
      return {
        ok: true,
        data: tasks[0],
        steps: [{ code: "DRY_RUN", message: "Task would be claimed" }],
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
      // OWNER DECISION: "no work available" is not an error, and this is the
      // same answer `vibeflow tasks --next --json` gives (ok:true, exit 0,
      // task:null). The wire payload for a claim is the Task itself, so a
      // `null` payload is the branch an agent reads: an object means claimed,
      // null means there was nothing to claim. NO_TASKS_AVAILABLE is gone —
      // a valid filter that matched nothing lands here too, so it was never a
      // separate situation to report.
      return { ok: true };
    }

    return { ok: true, data: claimed };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "CLAIM_TASK_ERROR",
        message: err instanceof Error ? err.message : "Failed to claim task",
        suggestion:
          "List the board (list_tasks) to see what is still todo, then claim_next_task again — an empty board is a success with a null payload, not this error",
      },
    };
  }
}

export async function addComment(
  ctx: OperationContext,
  input: AddCommentInputType,
): Promise<OperationResult<TaskComment>> {
  try {
    // Existence check FIRST: a comment on a task that is not there used to
    // CREATE that task (title "Untitled", selector "/", status todo) and answer
    // ok:true — a ghost task on the board that no agent asked for and that the
    // CLI refuses to edit.
    const resolved = await resolveTaskOrRefusal(ctx, input.id);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: {
          id: "dry-run",
          author: input.author,
          text: input.comment,
          createdAt: new Date().toISOString(),
        },
        steps: [{ code: "DRY_RUN", message: "Comment would be added" }],
      };
    }
    const { addComment: coreAddComment } = await import("../core/comments.js");
    // The RESOLVED id, never input.id: prefix tolerance and the existence
    // check are decided once, here.
    const comment = await coreAddComment(
      ctx.projectDir,
      resolved.id,
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
        suggestion:
          "Confirm the task exists (get_task) and the store is writable; the comment was NOT saved, so resend it",
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
    // Existence check FIRST. Without it an unknown id still wrote
    // `.vibeflow/tasks/files/<id>/<name>` and answered ok:true with a URL for
    // a file belonging to a task that does not exist.
    const resolved = await resolveTaskOrRefusal(ctx, input.id);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const buffer = Buffer.from(input.contentB64, "base64");
    // Gate BEFORE saveFile — reject manifest files, invalid extensions, oversized uploads
    const validation = validateFilename(input.filename, buffer.length);
    if (!validation.valid) {
      return {
        ok: false,
        error: {
          code: validation.errorCode,
          message: validation.errorMessage,
          suggestion: validation.errorSuggestion,
        },
      };
    }
    if (isDryRun(ctx, input)) {
      return {
        ok: true,
        data: {
          name: basename(input.filename),
          size: buffer.length,
          url: `/api/tasks/${resolved.id}/files/${encodeURIComponent(basename(input.filename))}`,
        },
        steps: [{ code: "DRY_RUN", message: "File would be attached" }],
      };
    }

    const info = saveFile(
      ctx.projectDir,
      resolved.id,
      input.filename,
      buffer,
    );
    return { ok: true, data: info };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "ATTACH_FILE_ERROR",
        message: err instanceof Error ? err.message : "Failed to attach file",
        suggestion:
          "The file was NOT written — confirm the task exists (get_task), the filename is in the allowed extension list, and the payload is under the size limit, then resend",
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
            suggestion: TASK_NOT_FOUND_SUGGESTION,
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
            suggestion:
              "The task file exists but did not parse — check it is valid JSON, or re-create the task",
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
        suggestion:
          "Call get_task for the id to check it exists and that its file parses, then retry export_prompt",
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
          suggestion:
            "That id resolves to no task — list_tasks (MCP) or 'vibeflow tasks' (CLI) to see the ids on this board",
        },
      };
    }
    return {
      ok: true,
      data: task,
      steps: [{ code: "DRY_RUN", message: "Verification would run" }],
    };
  }
  return withVerifySemaphore(async () => {
    const { verifyTask, addVerifySystemComment } = await import(
      "../commands/verify.js"
    );
    // ONE id rule. `resolveTaskId` is the shared "full id, or a prefix of one"
    // rule in core/tasks.ts that every other task-bearing surface calls. The
    // dryRun preview above already resolved through it, so the real call has to
    // agree with its own preview: the raw input used to go straight to the
    // engine, which looks the task file up EXACTLY, so a prefix the preview
    // accepted was refused here with E_NOT_FOUND. The engine still raises that
    // code for an id that resolves to nothing (resolveTaskId returns the input
    // unchanged then) — its code is not renamed here.
    const { resolveTaskId } = await import("../core/tasks.js");
    const taskId = resolveTaskId(ctx.projectDir, input.id);
    const timeoutMs = input.timeoutMs ?? 60_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();

    try {
      const result = await verifyTask(ctx.projectDir, taskId, {
        url: input.url,
        signal: ac.signal,
      } as { json?: boolean; url?: string; signal?: AbortSignal });
      // The RESOLVED id, always: a tool must never name a path it has not
      // resolved (the rule resolveTaskOrRefusal exists to enforce).
      await addVerifySystemComment(ctx.projectDir, taskId, result);
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
            // FALLBACK, not a rename. Several verify-engine codes carry no
            // `suggestion` of their own (E_NO_SELECTOR, E_AUTH_EXPIRED,
            // E_AUTH_CORRUPT, E_APP_NOT_RUNNING, E_NAVIGATION_FAILED,
            // E_CANCELLED), and this passthrough used to forward that absence
            // verbatim — so a reachable refusal arrived with a code and nothing
            // to act on, which is the one thing the contract forbids. The
            // engine's own text always wins when it has one; the code is
            // forwarded exactly as thrown.
            suggestion: ve.suggestion ?? VERIFY_ERROR_SUGGESTION,
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
      return {
        ok: false,
        error: {
          code: "VERIFY_TASK_ERROR",
          message: msg,
          suggestion:
            "Check that the app under test is running and reachable at the task's url, then run verify_task again",
        },
      };
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
        suggestion:
          "Check the backend is reachable and you are logged in (vibeflow login); nothing was pushed, so retry",
      },
    };
  }
}

/**
 * Start the kanban board server and return the instruction block the CLI
 * prints (kanban URL, localhost alt URL when bound to 0.0.0.0, agent prompt,
 * integration guide).
 *
 * Idempotent: a second call returns the instance the first started
 * (`alreadyRunning: true`) rather than fighting it for the port — that is what
 * backs the tool's `idempotentHint: true`.
 *
 * A port already taken by some OTHER process is a clean tool-level refusal
 * (`KANBAN_PORT_IN_USE`), never a raw stack trace.
 */
export async function startKanban(
  ctx: OperationContext,
  input: StartKanbanInputType,
): Promise<OperationResult<unknown>> {
  try {
    // Dynamic import: the server pulls in the MCP HTTP transport, which imports
    // this module's registry — a static edge would be a require cycle.
    const { startKanbanServer, guideText, DEFAULT_KANBAN_PORT } = await import(
      "../server/kanban-server.js"
    );
    const { buildIntegrationGuide, resolveDisplayUrl } = await import(
      "../server/startup-guide.js"
    );
    const port = input.port ?? DEFAULT_KANBAN_PORT;
    const host = input.host ?? "localhost";

    // Preview: report what WOULD be served and bind nothing. Resolved through
    // the same URL rule the real serve() uses, so the preview names the same
    // URLs the real call will.
    if (input.dryRun) {
      const guide = buildIntegrationGuide(
        resolveDisplayUrl(host, port),
      );
      return {
        ok: true,
        data: {
          alreadyRunning: false,
          started: false,
          wouldStart: true,
          url: guide.url,
          localUrl: guide.localUrl,
          kanbanUrl: guide.kanbanUrl,
          taskApiUrl: guide.taskApiUrl,
          overlayScriptUrl: guide.overlayScriptUrl,
          injectUrl: guide.injectUrl,
          guide,
          instructions: guideText(guide, false),
        },
        steps: [
          {
            code: "DRY_RUN",
            message: `Kanban server would start on port ${port} (host ${host}); nothing was started`,
          },
        ],
      };
    }

    const { instance, started } = await startKanbanServer({
      projectDir: ctx.projectDir,
      port: input.port,
      host: input.host,
    });
    return {
      ok: true,
      data: {
        // `alreadyRunning: true` is the idempotent path — the caller is told
        // it did not just launch a second server.
        alreadyRunning: !started,
        started,
        url: instance.url,
        localUrl: instance.localUrl ?? null,
        kanbanUrl: instance.guide.kanbanUrl,
        taskApiUrl: instance.guide.taskApiUrl,
        overlayScriptUrl: instance.guide.overlayScriptUrl,
        injectUrl: instance.guide.injectUrl,
        guide: instance.guide,
        // ANSI-free: a tool payload must not carry terminal escapes.
        instructions: guideText(instance.guide, true),
      },
    };
  } catch (err) {
    if (isAddrInUse(err)) {
      return {
        ok: false,
        error: {
          code: "KANBAN_PORT_IN_USE",
          message: `Port ${input.port ?? 3700} is already in use, so the kanban server could not start.`,
          suggestion:
            "Pass a different `port`, or stop whatever is listening on that port. If Vibeflow is already running here, call start_kanban again without a port.",
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "KANBAN_START_FAILED",
        message:
          err instanceof Error ? err.message : "Failed to start the kanban server",
        suggestion:
          "Check the port is free and the project directory is a Vibeflow project, then call start_kanban again",
      },
    };
  }
}

/**
 * The overlay/bookmarklet integration instructions — the content of the
 * `/inject` page, as text.
 *
 * Works whether or not the server is running. When it is not, the guide is
 * still returned (built against the default port) but carries an explicit
 * `serverRunning: false` and a note telling the caller to run `start_kanban`
 * first, so a client never mistakes a hypothetical URL for a live one.
 */
export async function getIntegrationGuide(
  _ctx: OperationContext,
  _input: GetIntegrationGuideInputType,
): Promise<OperationResult<unknown>> {
  try {
    const { getKanbanInstance, guideText, DEFAULT_KANBAN_PORT } = await import(
      "../server/kanban-server.js"
    );
    const { buildIntegrationGuide, resolveDisplayUrl } = await import(
      "../server/startup-guide.js"
    );
    const instance = getKanbanInstance();
    // Running -> the live instance's real URLs. Not running -> the default
    // port, flagged, so the caller knows to start the server first.
    const guide = instance
      ? instance.guide
      : buildIntegrationGuide(
          resolveDisplayUrl("localhost", DEFAULT_KANBAN_PORT),
        );
    return {
      ok: true,
      data: {
        serverRunning: !!instance,
        url: guide.url,
        localUrl: guide.localUrl,
        kanbanUrl: guide.kanbanUrl,
        taskApiUrl: guide.taskApiUrl,
        overlayScriptUrl: guide.overlayScriptUrl,
        injectUrl: guide.injectUrl,
        guide,
        instructions: guideText(guide, !!instance),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "INTEGRATION_GUIDE_ERROR",
        message:
          err instanceof Error
            ? err.message
            : "Failed to build the integration guide",
        suggestion:
          "This is a read-only tool; retry it, and check the project directory if it keeps failing",
      },
    };
  }
}
