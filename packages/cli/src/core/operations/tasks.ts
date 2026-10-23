/**
 * Portable record operations (ticket 3d613068).
 *
 * The local MCP task operations, migrated onto the async `TaskStore` ports:
 * every store access is an awaited port call resolved through the operation
 * context (`resolveOperationPorts`), never a direct `core/tasks.js` import.
 * The underlying storage functions stay synchronous — the local adapter
 * wraps them — so this migration changes HOW the operations wait, not what
 * the store does.
 *
 * Wire behaviour is unchanged: identical CLI output, identical MCP tool
 * responses, identical error codes. `core/operations.ts` re-exports this
 * module's functions unchanged, so the P0 registry callable bindings hold.
 */
import type {
  Task,
  TaskLink,
} from "../types.js";
import type { TaskStatus } from "../types.js";
import type { TaskListResult } from "../task-listing.js";
import type {
  OperationContext,
  OperationResult,
} from "../operations.js";
import { isDryRun } from "../operations.js";
import { resolveTaskOrRefusal } from "./resolution.js";
import { resolveOperationPorts } from "../task-store.js";
import { isRemoteReadError } from "../remote-task-store.js";
import { resolveClaimPorts, resolveReadPorts } from "../operation-context.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Field selection for single-task results (parity with list_tasks/get_task
 * and the CLI --fields flag): keep only the named top-level fields so a
 * status flip need not cost a full ticket dump. Empty/absent returns the
 * task unchanged.
 */
export function pickTaskFields(task: Task, fields: string[] | undefined): Task {
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

// Re-exported input schemas live in core/operations.ts (the canonical home
// is `@vibeflow-tools/api-core`); this module imports the types from there.
import type {
  ClaimNextTaskInputType,
  CreateTaskInputType,
  GetTaskInputType,
  ListTasksInputType,
  UpdateTaskInputType,
} from "@vibeflow-tools/api-core";

// ── Operations ─────────────────────────────────────────────────────────────

export async function listTasks(
  ctx: OperationContext,
  input: ListTasksInputType,
): Promise<OperationResult<TaskListResult>> {
  try {
    // P2 (ticket d7b9dc13): the READ runs against the authoritative store
    // for this mode — remote when saas, local otherwise — resolved through
    // the ONE shared decision in `core/operation-context.ts`. A remote
    // failure refuses below; it never falls back to local files.
    const { store } = resolveReadPorts(ctx);
    // Dynamic imports: the pure listing model and the read-notice helper
    // are not storage — they operate on the snapshot the port returned.
    const { queryTaskList } = await import("../task-listing.js");
    const { taskReadNotices } = await import("../task-record-read.js");
    // Parity contract 83159002: filter/scope/sort/limit/counts come from the
    // ONE shared listing model (core/task-listing.ts), the same one the CLI
    // `tasks` listing renders — including the filtered-query rule (a filter
    // is an explicit search, so children are included, exactly like the CLI).
    const reads: import("../task-record-read.js").TaskReadFinding[] = [];
    // LANE Q step 2: offer the status as a transport narrowing hint. The
    // adapter applies it ONLY when predicate-equal to client filtering
    // (remote pushes pushable statuses to `?status=`); every adapter the
    // hint does not apply to returns the whole board. queryTaskList below
    // still applies the FULL query, so either path converges to the same
    // answer — the hint only decides how many pages the fetch costs.
    const result = queryTaskList(
      await store.listTasks(
        ctx.projectDir,
        reads,
        input.status !== undefined ? { status: input.status } : undefined,
      ),
      {
        status: input.status,
        type: input.type,
        user: input.user,
        tag: input.tag,
        children: input.children,
        limit: input.limit,
      },
    );

    // Apply field selection (ticket b2e56212: projected rows ALWAYS carry
    // commentCount/fileCount — see attachOmissionCounts — so a projection
    // never silently hides that discussion or attachments exist).
    if (input.fields && input.fields.length > 0) {
      const { attachOmissionCounts } = await import("./files.js");
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
            ctx,
            filtered,
            t.id,
          )) as unknown as Task,
        );
      }
      result.tasks = projected;
    }

    const notices = taskReadNotices(reads);
    return { ok: true, data: result, ...(notices.length > 0 ? { steps: notices } : {}) };
  } catch (err) {
    return forwardListReadError(err);
  }
}

/**
 * CLI-only unbounded assembly (ticket d7b9dc13, plan step 5).
 *
 * `vibeflow tasks --all` fetches the whole matching set; the MCP surface
 * deliberately has no unbounded flag (KNOWN_DELTAS
 * cli-only-unbounded-listing), so this lives here as a typed internal —
 * same read ports, same shared listing model, plain (non-zod) input — and
 * is NOT registered in the manifest or the operation registry. Each page
 * is bounded (`pageSize`, DEFAULT_LIST_LIMIT unless given) via
 * `queryAllTasks`; unbounded overall, bounded per request.
 */
export interface ListAllTasksInput {
  status?: string;
  type?: string;
  user?: string;
  tag?: string[];
  children?: boolean;
  fields?: string[];
  pageSize?: number;
}

export async function listAllTasksForCli(
  ctx: OperationContext,
  input: ListAllTasksInput,
): Promise<OperationResult<TaskListResult>> {
  try {
    // Same authority as listTasks: the read ports for this mode — remote
    // when saas, local otherwise. A remote failure refuses; it never falls
    // back to local files.
    const { store } = resolveReadPorts(ctx);
    const { queryAllTasks } = await import("../task-listing.js");
    const { taskReadNotices } = await import("../task-record-read.js");
    const reads: import("../task-record-read.js").TaskReadFinding[] = [];
    // Same narrowing hint as listTasks (LANE Q step 2): `--all --status`
    // pages only over the matching set, still exhaustive via queryAllTasks.
    const result = queryAllTasks(
      await store.listTasks(
        ctx.projectDir,
        reads,
        input.status !== undefined ? { status: input.status } : undefined,
      ),
      {
        status: input.status,
        type: input.type,
        user: input.user,
        tag: input.tag,
        children: input.children,
        pageSize: input.pageSize,
      },
    );

    if (input.fields && input.fields.length > 0) {
      const { attachOmissionCounts } = await import("./files.js");
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
            ctx,
            filtered,
            t.id,
          )) as unknown as Task,
        );
      }
      result.tasks = projected;
    }

    const notices = taskReadNotices(reads);
    return { ok: true, data: result, ...(notices.length > 0 ? { steps: notices } : {}) };
  } catch (err) {
    return forwardListReadError(err);
  }
}

/**
 * The ONE list-read error mapping: a remote refusal already names the
 * actual failure and travels verbatim; anything else is a local store
 * problem. Shared by listTasks and listAllTasksForCli so the two cannot
 * disagree on what a dead backend looks like.
 */
function forwardListReadError(
  err: unknown,
): OperationResult<TaskListResult> {
  if (isRemoteReadError(err)) {
    return {
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.suggestion ? { suggestion: err.suggestion } : {}),
        ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
      },
    };
  }
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
    const { store } = resolveReadPorts(ctx);

    // Derive relations (parent/children/other) for ergonomic MCP access.
    // P2: the scope comes from the store — a remote detail already names
    // its relations, so deriving them must NOT cost a board enumeration.
    const { taskRelations } = await import("../task-links.js");
    const scope =
      typeof store.relationScope === "function"
        ? await store.relationScope(ctx.projectDir, task.id)
        : await store.listTasks(ctx.projectDir);
    const relations = taskRelations(scope, task.id);
    const data: Record<string, unknown> = { ...task, ...relations };

    // Apply field selection (ticket b2e56212: a projection ALWAYS carries
    // commentCount/fileCount — see attachOmissionCounts — so reading one
    // field never silently hides that discussion or attachments exist).
    if (input.fields && input.fields.length > 0) {
      const { attachOmissionCounts } = await import("./files.js");
      const fieldSet = new Set(input.fields);
      const filtered: Record<string, unknown> = {};
      for (const key of Object.keys(data)) {
        if (fieldSet.has(key)) {
          filtered[key] = data[key];
        }
      }
      // SAFETY: filtered contains a subset of keys; partial Task is still structurally valid for JSON serialization
      const withCounts = await attachOmissionCounts(
        ctx,
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

export async function createTask(
  ctx: OperationContext,
  input: CreateTaskInputType,
): Promise<OperationResult<Task>> {
  try {
    const { store } = resolveOperationPorts(ctx);
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

    const { validateLinkAddition } = await import("../task-links.js");
    // One store snapshot: the port's own resolution rule answers every
    // target below, and the validation board is the snapshot already loaded.
    const allTasks = await store.listTasks(ctx.projectDir);

    // Resolve `parent` (full id or unique prefix) to a parent link, matching
    // the wording the --set-parent path emits. The code differs from the
    // CLI's TASK_NOT_FOUND for the same situation (pre-existing, and out of
    // scope to change on a wire an existing consumer may parse) — but the
    // RECOVERY text must not depend on which surface refused.
    let parentLink: TaskLink | undefined;
    if (input.parent) {
      const parentTask = await store.getTask(ctx.projectDir, input.parent);
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
      const target = await store.getTask(ctx.projectDir, raw.taskId);
      if (!target) {
        const { TASK_NOT_FOUND_SUGGESTION } = await import("./resolution.js");
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
      if (!validation.ok) {
        const { TASK_NOT_FOUND_SUGGESTION } = await import("./resolution.js");
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
      }
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

    const { getGitUser } = await import("../git-user.js");
    const created = await store.createTask(ctx.projectDir, {
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
    const { store } = resolveOperationPorts(ctx);
    // Existence check FIRST, from the one shared resolver. A task-scoped
    // mutation must never reach its write without this.
    const resolved = await resolveTaskOrRefusal(ctx, input.id);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { id, task: existingTask } = resolved;

    // Attestation is resolved ONCE, before the review gate and before any
    // write, exactly as the CLI's --edit path does. The CLI consulted it
    // unconditionally; the MCP path skipped it entirely, so
    // `setVerify:"cannot"` with no reason and a bare `verifyReason` were both
    // accepted here and recorded nothing. The resolution is also the only
    // place a verdict becomes a stored value from here down.
    const { resolveVerifyAttestation } = await import(
      "../verify-attestation.js"
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
      const { loadSettings } = await import("../settings.js");
      const { decideReviewTransition } = await import(
        "../review-decision.js"
      );
      const settings = loadSettings(ctx.projectDir);
      // The pure decision over the ALREADY-RESOLVED task and the CURRENT
      // attachment names — the same matrix the CLI's local wrapper enforces,
      // without a second trip through the store's path layer.
      const attachmentNames = (
        await store.listFiles(ctx.projectDir, id)
      ).map((f) => f.name);
      const gate = decideReviewTransition({
        task: existingTask,
        attachmentNames,
        settings,
        opts: {
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
        taskId: id,
      });
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
    // the review gate, but applied to standalone setVerify too. (Single-
    // purpose type check, inlined: the canonical `isResearchType` lives in
    // core/tasks.js, which operation modules must not import — same reason
    // the review decision carries its own local mirror.)
    if (attestation.verdict) {
      const isResearch =
        (existingTask.type ?? "").toLowerCase() === "research";
      if (isResearch) {
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
        await import("../task-links.js");
      const { TASK_NOT_FOUND_SUGGESTION } = await import("./resolution.js");
      let current = await store.listTasks(ctx.projectDir);
      // Each helper validates against the state it is handed, so every pass
      // folds what the previous pass decided back into the board it re-read.
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
        // Resolve every named target through the PORT's own rule (full id or
        // unique prefix) — the single implementation of "what id does this
        // mean", not a second copy of the predicate. An unreadable target
        // resolves as missing here, exactly as the list-snapshot lookup it
        // replaces did (the list skips unreadable records). A miss keeps the
        // exact refusal `buildAddLinks` used to produce for the same input
        // (`Task <id> not found`, via validateLinkAddition) — the message is
        // wire, not prose, so it is reproduced verbatim rather than renamed
        // to the resolver's `Task not found: <id>`.
        const resolvedIncoming: TaskLink[] = [];
        for (const raw of incoming) {
          const target = await store.getTask(ctx.projectDir, raw.taskId);
          if (!target) {
            return {
              ok: false,
              error: {
                code: "TASK_NOT_FOUND",
                message: `Task ${raw.taskId} not found`,
                suggestion: TASK_NOT_FOUND_SUGGESTION,
              },
            };
          }
          resolvedIncoming.push({ taskId: target.id, type: raw.type });
        }
        const added = buildAddLinks({
          allTasks: current,
          taskId: existingTask.id,
          incoming: resolvedIncoming,
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
          const target = await store.getTask(ctx.projectDir, input.parent!);
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
      const { getGitUser } = await import("../git-user.js");
      if (input.status === "in-progress" || !existingTask.author) {
        updates.author = ctx.userId ?? getGitUser(ctx.projectDir).name;
      }
    }

    const task = await store.updateTask(ctx.projectDir, id, updates);
    if (!task) {
      return {
        ok: false,
        error: {
          code: "TASK_NOT_FOUND",
          message: `Task not found: ${id}`,
          suggestion: (await import("./resolution.js")).TASK_NOT_FOUND_SUGGESTION,
        },
      };
    }

    // Comments are written only after all gates pass (same ordering as CLI)
    // — and AWAITED (ticket 3d613068): the un-awaited fire-and-forget these
    // calls used to be meant a comment write could fail (or still be in
    // flight) while the tool answered ok:true. A failure AFTER the task write
    // is a durable partial effect, so it refuses LOUDLY as non-retryable:
    // the edit already landed, and resending the whole update would
    // re-apply it. Record the comment with add_comment instead.
    if (input.comment) {
      try {
        await store.addComment(ctx.projectDir, id, "agent", input.comment);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "UPDATE_COMMENT_FAILED",
            message: `Task updated but the comment was not recorded: ${err instanceof Error ? err.message : "comment write failed"}`,
            suggestion:
              "The edit above WAS saved — do not resend update_task (it would re-apply the edit). Record the comment with add_comment for the same task id.",
            retryable: false,
          },
        };
      }
    }

    // A "cannot" verdict's reason is recorded in the task's activity (system
    // comment) so the detail panel shows why the task carries no verdict. Only
    // when the verdict and reason both survived the gate.
    if (attestation.verdict === "cannot" && attestation.reason) {
      try {
        await store.addComment(
          ctx.projectDir,
          id,
          "agent",
          `**Cannot verify:** ${attestation.reason}`,
          undefined,
          "system",
        );
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "UPDATE_COMMENT_FAILED",
            message: `Task updated but the verify note was not recorded: ${err instanceof Error ? err.message : "comment write failed"}`,
            suggestion:
              "The edit and verdict above WERE saved — do not resend update_task (it would re-apply the edit). Record the note with add_comment for the same task id.",
            retryable: false,
          },
        };
      }
    }

    // Auto-commit after review transition (parity with CLI auto-commit path).
    // The codes are the CLI's own (`notices[].code`), so a consumer reading
    // either surface branches on the same string. The CLI emits no notice for
    // a commit that SUCCEEDED; the MCP tool always says which happened,
    // because here the notice is the only signal at all.
    const steps: import("../operations.js").OperationNotice[] = [];
    if (input.status === "review" && input.commitMessage) {
      const { loadSettings } = await import("../settings.js");
      const { commitTaskChanges } = await import("../git.js");
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
): Promise<OperationResult<Task | null>> {
  try {
    // P3 (ticket 6452504d): the claim resolves through the CLAIM ports —
    // remote adapter under mode saas (one versioned agent-claim POST, the
    // server owns selection and the write), the file-backed atomic
    // primitive otherwise. A remote refusal travels verbatim below; it is
    // never worked around with a local fallback or a list-then-PATCH.
    const { store } = resolveClaimPorts(ctx);
    if (isDryRun(ctx, input)) {
      // Read-only preview through the port's preview policy — the same
      // roots-first / live-children-fallback rule the live claim applies,
      // but nothing is written.
      const preview = await store.previewClaim(ctx.projectDir, {
        type: input.type,
        user: input.user,
        tag: input.tag,
      });
      if (!preview) {
        // A valid filter that matched nothing is the SAME situation as an
        // empty board, and the dry run must not disagree with the real path:
        // both answer "nothing was claimed" as a success with a null payload.
        return { ok: true, data: null };
      }
      const steps = [
        { code: "DRY_RUN", message: "Task would be claimed" },
      ];
      if (preview.childClaim) {
        steps.push({
          code: "CHILD_CLAIM",
          message: `No todo root was available — this would claim a todo child of ${preview.parentId ?? "(unknown parent)"}.`,
        });
      }
      return {
        ok: true,
        data: preview.task,
        steps,
      };
    }

    // Delegate to the atomic claim primitive for serialized, race-safe
    // claiming. Roots first, then the explicit child fallback — the SAME
    // revised rule the CLI's --next follows (ticket 4ab7104a), applied here
    // for MCP/CLI parity (ticket 2471abb345fa): only children of live work
    // are fallback-claimable. Never list+update here: that read-then-write
    // races, and the port-boundary race test proves it.
    const claimOpts = {
      type: input.type,
      user: input.user,
      tag: input.tag,
      author: ctx.userId,
    };
    let claimed = await store.claimNextTaskAtomic(ctx.projectDir, {
      ...claimOpts,
      rootsOnly: true,
    });
    let childClaim = false;
    if (!claimed) {
      claimed = await store.claimNextTaskAtomic(ctx.projectDir, claimOpts);
      childClaim = claimed !== null;
    }

    if (!claimed) {
      // OWNER DECISION: "no work available" is not an error, and this is the
      // same answer `vibeflow tasks --next --json` gives (ok:true, exit 0,
      // task:null). A `null` payload is the branch an agent reads: an object
      // means claimed, null means there was nothing to claim.
      // NO_TASKS_AVAILABLE is gone — a valid filter that matched nothing
      // lands here too, so it was never a separate situation to report.
      return { ok: true, data: null };
    }

    if (!childClaim) return { ok: true, data: claimed };
    // Unambiguous on the wire (as `notices`): this run claimed a CHILD,
    // not a root — name the parent so the agent knows which unit it sliced
    // off, mirroring the CLI's CHILD CLAIM line. (Single-purpose parent
    // lookup, inlined: the canonical `getParentId` lives in core/tasks.js,
    // which operation modules must not import.)
    const parentId =
      (claimed.links ?? []).find((l) => l.type === "parent")?.taskId ??
      "(unknown parent)";
    return {
      ok: true,
      data: claimed,
      steps: [
        {
          code: "CHILD_CLAIM",
          message: `No todo root was available — claimed a todo child of ${parentId}.`,
        },
      ],
    };
  } catch (err) {
    // A remote refusal travels VERBATIM (same rule as the read ops): the
    // code names the actual failure (REMOTE_CLAIM_UNSUPPORTED for an old
    // server, E_NOT_AUTHENTICATED, scope, transport) — never relabelled to
    // a catch-all that would hide the recovery.
    if (isRemoteReadError(err)) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.suggestion ? { suggestion: err.suggestion } : {}),
          ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
        },
      };
    }
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
