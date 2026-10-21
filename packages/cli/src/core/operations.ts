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
} from "../core/types.js";
import {
  compareTasksByPriorityThenCreated,
  type TaskStatus,
} from "../core/types.js";
import type { FileInfo } from "../core/files.js";
import type { TaskListResult } from "../core/task-listing.js";
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
// ── Input schemas ──────────────────────────────────────────────────────────
// Canonical home is `@vibeflow-tools/api-core` (P4a decision (B): both the
// local and the hosted surface consume the same schemas); imported for the
// run functions below and re-exported so the manifest, the CLI and the
// drift tests keep importing from this module unchanged.
import {
  AddCommentInput,
  type AddCommentInputType,
  AttachFileInput,
  type AttachFileInputType,
  ClaimNextTaskInput,
  type ClaimNextTaskInputType,
  CreateTaskInput,
  type CreateTaskInputType,
  GetIntegrationGuideInput,
  type GetIntegrationGuideInputType,
  GetProjectInput,
  type GetProjectInputType,
  GetTaskInput,
  type GetTaskInputType,
  ListTasksInput,
  type ListTasksInputType,
  PullInput,
  type PullInputType,
  StartKanbanInput,
  type StartKanbanInputType,
  UpdateTaskInput,
  type UpdateTaskInputType,
  VerifyTaskInput,
  type VerifyTaskInputType,
} from "@vibeflow-tools/api-core";
export {
  AddCommentInput,
  type AddCommentInputType,
  AttachFileInput,
  type AttachFileInputType,
  ClaimNextTaskInput,
  type ClaimNextTaskInputType,
  CreateTaskInput,
  type CreateTaskInputType,
  GetIntegrationGuideInput,
  type GetIntegrationGuideInputType,
  GetProjectInput,
  type GetProjectInputType,
  GetTaskInput,
  type GetTaskInputType,
  ListTasksInput,
  type ListTasksInputType,
  PullInput,
  type PullInputType,
  StartKanbanInput,
  type StartKanbanInputType,
  UpdateTaskInput,
  type UpdateTaskInputType,
  VerifyTaskInput,
  type VerifyTaskInputType,
};

/**
 * Field selection for single-task results (parity with list_tasks/get_task
 * and the CLI --fields flag): keep only the named top-level fields so a
 * status flip need not cost a full ticket dump. Empty/absent returns the
 * task unchanged.
 */
function pickTaskFields(task: Task, fields: string[] | undefined): Task {
  if (!fields || fields.length === 0) return task;
  const fieldSet = new Set(fields);
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(task)) {
    if (fieldSet.has(key)) {
      // SAFETY: Task is a plain JSON object; runtime keys match the type's properties
      picked[key] = (task as unknown as Record<string, unknown>)[key];
    }
  }
  // SAFETY: picked contains a subset of Task's keys; partial Task is still structurally valid for JSON serialization
  return picked as unknown as Task;
}

/**
 * WHAT/WHY (ticket b2e56212, change 3): a `fields` projection used to omit
 * `comments` (and `files`) with NO signal they exist — an owner ticket was
 * read without comments, the owner's own bug report on it went unseen, and
 * a live functional regression was mis-diagnosed as visual taste. So every
 * projected row carries the cheap counts of what it omitted:
 * `commentCount` / `fileCount`, read from the SAME sidecar readers the
 * human listing renders (listComments excludes deleted, like the display).
 * Attached ALWAYS on a projected response — even when `fields` names the
 * arrays (counts are cheap and unambiguous) — and never on a full response
 * (the arrays themselves are the signal there). A sidecar read that throws
 * falls back to the embedded array length, never to a failed listing.
 * SCOPE: the read surfaces (list_tasks/get_task + CLI --json). The write
 * surfaces (create/update `fields`) return the just-written object and are
 * deliberately untouched — their own ticket if that ever misleads.
 */
async function attachOmissionCounts(
  projectDir: string,
  row: Record<string, unknown>,
  taskId: string,
): Promise<Record<string, unknown>> {
  let commentCount: number;
  let fileCount: number;
  try {
    const { listComments } = await import("../core/comments.js");
    commentCount = listComments(projectDir, taskId).length;
  } catch {
    const embedded = (row as { comments?: unknown }).comments;
    commentCount = Array.isArray(embedded) ? embedded.length : 0;
  }
  try {
    const { listFiles } = await import("../core/files.js");
    fileCount = listFiles(projectDir, taskId).length;
  } catch {
    const embedded = (row as { files?: unknown }).files;
    fileCount = Array.isArray(embedded) ? embedded.length : 0;
  }
  return { ...row, commentCount, fileCount };
}

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
): Promise<OperationResult<TaskListResult>> {
  try {
    // Dynamic import to avoid circular dependencies
    const { listTasks: coreListTasks } = await import("../core/tasks.js");
    const { queryTaskList } = await import("../core/task-listing.js");
    // Parity contract 83159002: filter/scope/sort/limit/counts come from the
    // ONE shared listing model (core/task-listing.ts), the same one the CLI
    // `tasks` listing renders — including the filtered-query rule (a filter
    // is an explicit search, so children are included, exactly like the CLI).
    const result = queryTaskList(coreListTasks(ctx.projectDir), {
      status: input.status,
      type: input.type,
      user: input.user,
      tag: input.tag,
      children: input.children,
      limit: input.limit,
    });

    // Apply field selection (ticket b2e56212: projected rows ALWAYS carry
    // commentCount/fileCount — see attachOmissionCounts — so a projection
    // never silently hides that discussion or attachments exist).
    if (input.fields && input.fields.length > 0) {
      const fieldSet = new Set(input.fields);
      const projected: Task[] = [];
      for (const t of result.tasks) {
        const filtered: Record<string, unknown> = {};
        for (const key of Object.keys(t)) {
          if (fieldSet.has(key)) {
            // SAFETY: Task is a plain JSON object; runtime keys match the type's properties
            filtered[key] = (t as unknown as Record<string, unknown>)[key];
          }
        }
        // SAFETY: filtered contains a subset of Task's keys; partial Task is still structurally valid for JSON serialization
        projected.push(
          (await attachOmissionCounts(
            ctx.projectDir,
            filtered,
            t.id,
          )) as unknown as Task,
        );
      }
      result.tasks = projected;
    }

    return { ok: true, data: result };
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

    // Apply field selection (ticket b2e56212: a projection ALWAYS carries
    // commentCount/fileCount — see attachOmissionCounts — so reading one
    // field never silently hides that discussion or attachments exist).
    if (input.fields && input.fields.length > 0) {
      const fieldSet = new Set(input.fields);
      const filtered: Record<string, unknown> = {};
      for (const key of Object.keys(data)) {
        if (fieldSet.has(key)) {
          filtered[key] = data[key];
        }
      }
      // SAFETY: filtered contains a subset of keys; partial Task is still structurally valid for JSON serialization
      const withCounts = await attachOmissionCounts(
        ctx.projectDir,
        filtered,
        task.id,
      );
      // SAFETY: withCounts is the projected subset plus numeric count keys; structurally valid for JSON serialization as a partial Task
      return { ok: true, data: withCounts as unknown as Task };
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
    // Links on create are MERGE, identical to `update_task`'s `links` /
    // `addLinks` union: `parent` (when given) and `links` are folded into
    // one set, a pair named twice is a no-op, and every pair is validated
    // through `validateLinkAddition` — the same function the update path
    // reaches via `buildAddLinks` — so the two surfaces cannot diverge.
    // A brand-new task has no id/links/descendants yet, so self-link and
    // cycle are structurally impossible; a dangling target is the only
    // rejection, plus the duplicate-parent rule when two parents are named.
    // `links: []` is refused (E_USAGE), exactly as on update: under merge an
    // empty array names no links, and honouring it as a no-op would hide a
    // client that still assumes replace semantics.
    if (input.links !== undefined && input.links.length === 0) {
      return {
        ok: false,
        error: {
          code: "E_USAGE",
          message:
            "`links: []` is refused — `links` MERGES, so an empty array names no links and cannot mean \"no links\"",
          suggestion:
            "Omit `links` entirely for no links. To link the new task, name taskId+type pairs in `links` (and/or pass `parent` for the single-parent case).",
        },
      };
    }

    const { listTasks: coreListTasks, matchesIdOrPrefix } = await import(
      "../core/tasks.js"
    );
    const { validateLinkAddition } = await import("../core/task-links.js");
    // One store scan: matchesIdOrPrefix IS the resolution rule, applied to
    // the list already loaded. resolveTaskId() re-ran listTasks just to
    // pick the first match from the same directory.
    const allTasks = coreListTasks(ctx.projectDir);

    // Resolve `parent` (full id or unique prefix) to a parent link, matching
    // the wording the --set-parent path emits. The code differs from the
    // CLI's TASK_NOT_FOUND for the same situation (pre-existing, and out of
    // scope to change on a wire an existing consumer may parse) — but the
    // RECOVERY text must not depend on which surface refused.
    let parentLink: TaskLink | undefined;
    if (input.parent) {
      const parentTask = allTasks.find((t) =>
        matchesIdOrPrefix(t, input.parent!),
      );
      if (!parentTask) {
        return {
          ok: false,
          error: {
            code: "CREATE_TASK_ERROR",
            message: `Parent task not found: ${input.parent}`,
            suggestion: `The parent task does not exist — drop \`parent\` to create a root task, or pass an id from list_tasks (MCP) / 'vibeflow tasks' (CLI)`,
          },
        };
      }
      parentLink = { taskId: parentTask.id, type: "parent" };
    }

    // The union, deduped on taskId+type AFTER prefix resolution (so a parent
    // named both ways is one pair, not a duplicate-parent refusal) — the
    // same dedupe rule `buildAddLinks` applies, as a no-op not an error.
    const seen = new Set<string>();
    const incoming: TaskLink[] = [];
    for (const raw of [...(input.links ?? []), ...(parentLink ? [parentLink] : [])]) {
      const target = allTasks.find((t) => matchesIdOrPrefix(t, raw.taskId));
      if (!target) {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${raw.taskId}`,
            suggestion: TASK_NOT_FOUND_SUGGESTION,
          },
        };
      }
      const key = `${target.id} ${raw.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      incoming.push({ taskId: target.id, type: raw.type });
    }

    // Validate through the shared rule, folded over a synthetic new-task
    // stub the same way `buildAddLinks` folds over the stored task: each
    // candidate is checked against the post-merge state (accepted links
    // folded in first), so a second `parent` is refused with the
    // --set-parent wording and a dangling target can never be written.
    const NEW_TASK_STUB_ID = "__new_task__";
    let accepted: TaskLink[] = [];
    for (const link of incoming) {
      const validation = validateLinkAddition({
        allTasks: [
          ...allTasks,
          {
            id: NEW_TASK_STUB_ID,
            title: input.title,
            description: input.description ?? "",
            status: "todo",
            selector: "/",
            created: new Date(0).toISOString(),
            comments: [],
            files: [],
            links: accepted,
          } as Task,
        ],
        fromId: NEW_TASK_STUB_ID,
        toId: link.taskId,
        type: link.type,
      });
      if (!validation.ok)
        return {
          ok: false,
          error: {
            code: validation.code,
            message: validation.reason,
            suggestion:
              validation.code === "TASK_NOT_FOUND"
                ? TASK_NOT_FOUND_SUGGESTION
                : "The link you asked to set on the new task was refused as invalid — fix what the message names and resend. Nothing was created.",
          },
        };
      accepted = [...accepted, link];
    }
    const links: TaskLink[] | undefined =
      accepted.length > 0 ? accepted : undefined;

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
    const created = coreCreateTask(ctx.projectDir, {
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

    // Field selection (parity with list_tasks/get_task and the CLI --fields).
    if (input.fields && input.fields.length > 0) {
      return { ok: true, data: pickTaskFields(created, input.fields) };
    }
    return { ok: true, data: created };
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
    // `parent` (set/replace/clear the single parent link) is the fifth link
    // style — the MCP spelling of the CLI's --set-parent / --no-parent.
    const parentProvided = input.parent !== undefined;
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
      removeLinksProvided ||
      parentProvided
    ) {
      const { buildAddLinks, buildRemoveLinks, buildSetParentLinks } =
        await import("../core/task-links.js");
      const { listTasks: coreListTasks, matchesIdOrPrefix } = await import(
        "../core/tasks.js"
      );
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

      // 3. removeLinks: subtract exactly the named pairs, after the merge,
      // so "add X back except Y" is expressible.
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
        current = current.map((t) =>
          t.id === existingTask.id ? { ...t, links: next ?? [] } : t,
        );
      }

      // 4. parent LAST: set/replace (or clear on "") the single parent link
      // through buildSetParentLinks — the same helper the CLI --set-parent /
      // --no-parent path uses, validated against the board the passes above
      // left behind. Last-wins is deliberate: clearLinks:true + parent:X
      // means "start over with exactly this parent".
      if (parentProvided) {
        let parentId: string | null;
        if (input.parent === "") {
          parentId = null;
        } else {
          const target = current.find((t) =>
            matchesIdOrPrefix(t, input.parent!),
          );
          if (!target) {
            return {
              ok: false,
              error: {
                code: "TASK_NOT_FOUND",
                message: `Parent task not found: ${input.parent}`,
                suggestion: TASK_NOT_FOUND_SUGGESTION,
              },
            };
          }
          parentId = target.id;
        }
        const applied = buildSetParentLinks({
          allTasks: current,
          taskId: existingTask.id,
          parentId,
        });
        if (!applied.ok)
          return {
            ok: false,
            error: {
              code: applied.code,
              message: applied.reason,
              suggestion:
                applied.code === "TASK_NOT_FOUND"
                  ? TASK_NOT_FOUND_SUGGESTION
                  : "The parent link was refused as invalid — fix what the message names and resend. Existing links are untouched by a refused set.",
            },
          };
        next = applied.links;
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
      removeLinksProvided ||
      parentProvided
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

    // Field selection (parity with list_tasks/get_task and the CLI --fields).
    return {
      ok: true,
      data: pickTaskFields(task, input.fields),
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
      const {
        listTasks: coreListTasks,
        isChildTask,
        isParentChainActive,
        getParentId,
      } = await import("../core/tasks.js");
      let tasks = coreListTasks(ctx.projectDir);
      // Chain liveness needs the FULL board: an in-progress/review parent
      // is filtered out of the todo pool below, but it still makes its
      // children claimable. Check chains against the snapshot, not the pool.
      const chainScope = tasks;
      tasks = tasks.filter((t) => t.status === "todo");
      if (input.type) tasks = tasks.filter((t) => t.type === input.type);
      // `user` is a documented ClaimNextTaskInput field, so the dry run
      // applies it exactly as the atomic path does (author identity match).
      if (input.user) tasks = tasks.filter((t) => t.author === input.user);
      if (input.tag && input.tag.length > 0) {
        tasks = tasks.filter(
          (t) => t.tags && input.tag!.every((tag) => t.tags!.includes(tag)),
        );
      }
      // Roots first, children of live work only as an explicit fallback —
      // the SAME revised rule the CLI's --next follows (ticket 4ab7104a):
      // the root is the unit of work, and a todo child of a backlog/done
      // parent (or dangling link) is refused, never invisible. MCP/CLI
      // parity, ticket 2471abb345fa.
      const claimableChild = (t: (typeof tasks)[number]) =>
        !isChildTask(t) || isParentChainActive(chainScope, t);
      let pool = tasks.filter((t) => !isChildTask(t));
      let childClaim = false;
      if (pool.length === 0) {
        pool = tasks.filter(claimableChild);
        childClaim = pool.length > 0;
      }
      // listTasks() returns files in readdir order, which is NOT the claim
      // order (filenames are random ids). Sort with the SAME comparator the
      // atomic path uses inside its lock, so the preview names the task the
      // real call will actually claim.
      pool.sort(compareTasksByPriorityThenCreated);
      if (pool.length === 0) {
        // A valid filter that matched nothing is the SAME situation as an
        // empty board, and the dry run must not disagree with the real path:
        // both answer "nothing was claimed" as a success with a null payload.
        return { ok: true };
      }
      const preview = pool[0];
      const steps = [
        { code: "DRY_RUN", message: "Task would be claimed" },
      ];
      if (childClaim) {
        steps.push({
          code: "CHILD_CLAIM",
          message: `No todo root was available — this would claim a todo child of ${getParentId(preview) ?? "(unknown parent)"}.`,
        });
      }
      return {
        ok: true,
        data: preview,
        steps,
      };
    }

    // Delegate to the atomic claim primitive for serialized, race-safe
    // claiming. Roots first, then the explicit child fallback — the SAME
    // revised rule the CLI's --next follows (ticket 4ab7104a), applied here
    // for MCP/CLI parity (ticket 2471abb345fa): only children of live work
    // are fallback-claimable; the old rule that also took children of
    // non-todo parents sliced fragments off parked units.
    const core = await import("../core/tasks.js");
    const claimOpts = {
      type: input.type,
      user: input.user,
      tag: input.tag,
      author: ctx.userId,
    };
    let claimed = core.claimNextTaskAtomic(ctx.projectDir, {
      ...claimOpts,
      rootsOnly: true,
    });
    let childClaim = false;
    if (!claimed) {
      claimed = core.claimNextTaskAtomic(ctx.projectDir, claimOpts);
      childClaim = claimed !== null;
    }

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

    if (!childClaim) return { ok: true, data: claimed };
    // Unambiguous on the wire (as `notices`): this run claimed a CHILD,
    // not a root — name the parent so the agent knows which unit it sliced
    // off, mirroring the CLI's CHILD CLAIM line.
    return {
      ok: true,
      data: claimed,
      steps: [
        {
          code: "CHILD_CLAIM",
          message: `No todo root was available — claimed a todo child of ${core.getParentId(claimed) ?? "(unknown parent)"}.`,
        },
      ],
    };
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
          "The file was NOT written — confirm the task exists (get_task), the filename is not an executable type (.exe/.dll/.ps1 and siblings are refused; zip it first), and the payload is under the size limit, then resend",
      },
    };
  }
}

// REMOVED (ticket 53b622fc, BREAKING): exportPrompt — the whole-board
// prompt exporter — was deleted with its export_prompt tool. Its single-task
// read is covered by get_task and its human render by `vibeflow tasks --get`
// (both via renderTaskForAgent in core/tasks.ts, which stays: the CLI
// display paths and watch.ts still use it). Callers needing the old
// multi-task dump: loop get_task over the ids from list_tasks.

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

export const PushTasksInput = z.object({
  workspace: z.string().optional(),
  keepLocalFiles: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
export type PushTasksInputType = z.infer<typeof PushTasksInput>;

/**
 * Pull the online board into the local task store (the MCP spelling of
 * `vibeflow pull`). Additive and never destructive: the merge adds missing
 * tasks, merges conflicting fields (local wins unless `preferRemote`), and
 * deletes nothing. `out` redirects the write target to another project
 * root; omit it to pull into the server's own project.
 */
export async function pullFromBoard(
  ctx: OperationContext,
  input: PullInputType,
): Promise<OperationResult<unknown>> {
  if (isDryRun(ctx, input)) {
    // Preview WITHOUT touching the network or the store: the counts a real
    // pull would report cannot be known without fetching the archive, so the
    // preview names the board selection it would pull from instead of
    // inventing numbers. Anything that would write answers this way.
    return {
      ok: true,
      data: {
        dryRun: true,
        board: input.board ?? null,
        out: input.out ?? null,
        preferRemote: input.preferRemote === true,
      },
      steps: [{ code: "DRY_RUN", message: "Pull would run" }],
    };
  }
  try {
    const { pull } = await import("../commands/pull.js");
    // silent: stdout is the JSON-RPC channel over MCP stdio — the human
    // lines pull() prints would corrupt the protocol stream.
    const result = await pull(ctx.projectDir, {
      board: input.board,
      out: input.out,
      preferRemote: input.preferRemote,
      dryRun: false,
      json: true,
      silent: true,
    });
    // pull() returns void on early exits (no login, no board selected).
    // Normalise to an object so the success envelope is always
    // serialisable — JSON.stringify(undefined) is undefined, which would
    // violate the MCP TextContent contract (text: string).
    return { ok: true, data: (result ?? {}) as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "PULL_ERROR",
        message: err instanceof Error ? err.message : "Failed to pull the board",
        suggestion:
          "Check the backend is reachable and you are logged in (vibeflow login); nothing was written, so retry",
      },
    };
  }
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
