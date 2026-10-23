/**
 * CLI read renderers (ticket d7b9dc13, plan step 6, parent e7482da5).
 *
 * The ONLY place `tasks` list/get output is assembled. The data path is
 * operations-first: `src/index.ts` list/get branches obtain every row
 * through the named registered operations (`listTasks` /
 * `listAllTasksForCli` / `getTask` in `core/operations/tasks.ts`), which
 * themselves read through `resolveReadPorts` — the ONE shared
 * local-vs-remote authority decision. This module then shapes those
 * operation results into the established CLI envelopes (JSON payloads,
 * refusal envelopes, exit codes).
 *
 * PORT RULE (the bug this ticket exists to prevent): this module must never
 * resolve a store on its own. It imports no concrete store
 * (`core/tasks.js`, `core/comments.js`, `core/files.js`) and no remote
 * client (`saas/client.js`) — only types plus the operations-layer helpers
 * that already consumed the ports. Display details that need a store read
 * (comment/file counts for projections) arrive as caller-supplied values
 * read through the caller's ports. A renderer that reaches around the ports
 * reintroduces the phantom-record split (one surface reading local files
 * while the authority is remote), so the boundary test
 * (`tests/unit/cli/task-reads-render.test.ts`) fails any runtime import
 * from the storage or remote-client modules here.
 *
 * Human (non-JSON) printers stay in `src/index.ts`: they need file-local
 * display context the portable operations deliberately do not carry
 * (absolute task file paths, kanban port URLs, agent-instruction settings).
 * What moved here is every JSON envelope and every refusal/exit mapping, so
 * the two modes cannot drift on what a code means — and both modes' human
 * printers are fed operation data, never a second store read.
 */
import type { Task } from "../../core/types.js";
import type { TaskListResult } from "../../core/task-listing.js";
import type { OperationError } from "../../core/operations.js";
import { ExitCode } from "../../core/exit-codes.js";

// ── Refusals ───────────────────────────────────────────────────────────────

/**
 * The exit code for a failed list/get read. TASK_NOT_FOUND is addressable
 * (the id is wrong); ambiguous/usage refusals are caller errors; everything
 * else (dead backend, rejected token, truncated board) is a general
 * failure — the same mapping the inline branches used before the P2 slice.
 */
export function refusalExitCode(code: string): number {
  if (code === "TASK_NOT_FOUND") return ExitCode.NOT_FOUND;
  if (code === "E_AMBIGUOUS" || code === "E_USAGE") return ExitCode.USAGE;
  return ExitCode.GENERAL;
}

/**
 * The `--json` refusal envelope for an operation error. Operation errors
 * already carry the wire code/message/suggestion/retryable (remote refusals
 * travel verbatim from `RemoteReadError`, formatted with the shared
 * `saasReadErrorMessage`), so the renderer forwards them unchanged — it
 * must not relabel a remote cause as a local store problem.
 */
export function operationRefusalEnvelope(error: OperationError): {
  ok: false;
  code: string;
  message: string;
  suggestion?: string;
  retryable?: boolean;
} {
  return {
    ok: false,
    code: error.code,
    message: error.message,
    ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
  };
}

// ── Field projection ───────────────────────────────────────────────────────

/**
 * Keep only the named top-level fields. The CLI's `--fields` spelling of
 * the operation layer's `pickTaskFields` — one rule for what a projection
 * keeps, applied to operation data. Unknown fields are dropped (never an
 * error), matching the historical CLI behaviour.
 */
export function pickFields<T extends Record<string, unknown>>(
  task: T,
  fields: string[],
): Record<string, unknown> {
  if (fields.length === 0) return { ...(task as Record<string, unknown>) };
  const fieldSet = new Set(fields);
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(task)) {
    if (fieldSet.has(key)) {
      picked[key] = (task as Record<string, unknown>)[key];
    }
  }
  return picked;
}

/**
 * Field projection that never hides the omission counts (ticket b2e56212):
 * named fields are kept and commentCount/fileCount ride along whenever the
 * source row carries them — the operation attached them from the read
 * ports, so dropping them would un-count a projection the operation
 * deliberately counted. Unknown fields are still dropped.
 */
export function pickPreservingCounts(
  row: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const picked = pickFields(row, fields);
  for (const key of ["commentCount", "fileCount"]) {
    if (!(key in picked) && typeof row[key] === "number") {
      picked[key] = row[key];
    }
  }
  return picked;
}

// ── List envelopes ─────────────────────────────────────────────────────────

/**
 * The local-shape list payload: every count the shared listing model
 * reports, plus the projection counts. Built from the operation's
 * `TaskListResult` — the same object the MCP `list_tasks` tool returns —
 * so the CLI and MCP cannot disagree on what a page means.
 *
 * Counts note (ticket b2e56212): a projection ALWAYS carries
 * commentCount/fileCount. The OPERATION attaches them from the read ports
 * for the mode (local sidecars under mode local, the remote detail under
 * mode saas) — the only layer allowed to read a store — so this envelope
 * passes them through untouched and never invents them.
 */
export function localListJsonPayload(
  result: TaskListResult,
  fields: string[],
): Record<string, unknown> {
  // SAFETY: Task rows are plain JSON-serializable objects; Record<string, unknown> is the superset for field picking.
  const tasks =
    fields.length === 0
      ? result.tasks
      : result.tasks.map((t) =>
          pickPreservingCounts(t as unknown as Record<string, unknown>, fields),
        );
  return {
    tasks,
    totalMatching: result.totalMatching,
    totalRoots: result.totalRoots,
    returned: result.returned,
    limit: result.limit,
    ...(result.limitNotice ? { limitNotice: result.limitNotice } : {}),
    truncated: result.truncated,
    ...(result.hint ? { hint: result.hint } : {}),
    hiddenChildren: result.hiddenChildren,
    offset: result.offset,
    remaining: result.remaining,
    nextCursor: result.nextCursor,
    order: result.order,
  };
}

/**
 * The remote-shape list payload: the legacy `tasks` + `hiddenChildren`
 * envelope, with rows projected when `--fields` is given. The rows come
 * from the operation (mapped remote records through the shared listing
 * model), so an unfiltered listing still hides children, `--children`
 * still reveals them, and a stale local record can never appear here.
 *
 * Counts note: remote projections intentionally carry NO locally-invented
 * counts. The operation already pins `commentCount`/`fileCount` onto
 * projected rows from the REMOTE detail (never local sidecars); this
 * envelope passes the operation rows through untouched.
 */
export function remoteListJsonPayload(
  result: TaskListResult,
  fields: string[],
): Record<string, unknown> {
  // SAFETY: Task rows are plain JSON-serializable objects; Record<string, unknown> is the superset for field picking.
  const projected =
    fields.length === 0
      ? result.tasks
      : result.tasks.map((t) =>
          pickFields(t as unknown as Record<string, unknown>, fields),
        );
  return {
    tasks: projected,
    hiddenChildren: result.hiddenChildren,
  };
}

// ── Get envelopes ──────────────────────────────────────────────────────────

/**
 * The local-shape get payload: the task with its comments/files arrays
 * (read by the caller through its ports) under the legacy `task` key,
 * projected when `--fields` names fields. A projection keeps the
 * operation-attached omission counts (ticket b2e56212 — the same rule as
 * the list envelope: skimming fields never silently hides discussion or
 * attachments), so the pick is count-preserving, not a plain subset.
 */
export function localGetJsonPayload(
  task: Task,
  fields: string[],
  extras: { comments: unknown[]; files: unknown[] },
): Record<string, unknown> {
  // SAFETY: Task is a plain JSON-serializable object; Record<string, unknown> is the superset for field picking.
  const source = task as unknown as Record<string, unknown>;
  if (fields.length === 0) {
    return { task: { ...source, ...extras } };
  }
  return { task: pickPreservingCounts(source, fields) };
}

/**
 * The remote-shape get payload: the operation's task (mapped remote detail
 * plus derived relations), passed through under the legacy `task` key. Keys
 * the server never sent stay absent — never synthesised to null/[].
 */
export function remoteGetJsonPayload(
  task: Task,
  fields: string[],
): Record<string, unknown> {
  // SAFETY: Task is a plain JSON-serializable object; Record<string, unknown> is the superset for field picking.
  return {
    task: pickFields(task as unknown as Record<string, unknown>, fields),
  };
}
