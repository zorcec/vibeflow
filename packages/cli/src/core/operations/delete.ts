/**
 * Delete operation (ticket 4a5f7df6, P5).
 *
 * The shared implementation behind `vibeflow tasks --delete <id> [--yes]`.
 * There is deliberately NO MCP delete tool (registry mapping `missing`):
 * a destructive operation an agent can trigger in a loop is a footgun, so
 * deletion stays a human CLI action. The operation is still shared-layer
 * code so the local-vs-online decision lives in one place with the same
 * characterization discipline as the other P5 extractions.
 *
 * Contract (mirrors the inline branch this replaces, byte-for-byte on every
 * pinned envelope):
 * - empty id → TASK_NOT_FOUND before either store is read (every id is a
 *   prefix of the empty string, so resolving it could name the whole board);
 * - resolution through ONE listing-based rule (exact id wins, unique prefix
 *   resolves, ambiguous names titled candidates): refusals carry
 *   TASK_NOT_FOUND / E_AMBIGUOUS with the CLI's exact wording;
 * - without confirmation: CONFIRM_REQUIRED preview refusal (non-zero exit,
 *   nothing written) — online names the transitive cascade cone, local
 *   names the dangling children;
 * - `--yes --dry-run`: the confirmed plan (root first, then the online
 *   cone), exit 0, ZERO mutations in both stores — except a locally-refused
 *   parent, whose dry run is the refusal;
 * - local: a parent with children is refused even WITH --yes (HAS_CHILDREN)
 *   — no cascade on this surface; a leaf deletes exactly one row;
 * - online: the v0 DELETE CASCADES, so a parent proceeds with an explicit
 *   warning; afterwards the local clones of every remotely-deleted id are
 *   dropped (best-effort) so a later push cannot recreate them;
 * - a 404 between resolve and write is TASK_NOT_FOUND; a structured server
 *   refusal keeps its code verbatim; anything else maps through the shared
 *   saas failure ladder.
 *
 * The human itemized block (child lines, deeper-count) travels on the
 * refusal's `preview` — the JSON envelope carries only the one-line message,
 * exactly as today. Renderers must not re-read any store.
 */
import type { OperationContext } from "../operations.js";
import { isDryRun } from "../operations.js";
import { resolveReadPorts } from "../operation-context.js";
import { resolveSaasTaskId } from "../id-resolution.js";
import { localTaskStore } from "../task-store.js";
import { saasFailure } from "../../saas/failure.js";
import { isRemoteReadError } from "../remote-task-store.js";

/** One row of the delete plan: enough to resolve, warn, and render. */
export interface DeletePlanRow {
  id: string;
  title: string;
  status: string;
  links: Array<{ taskId: string; type: string }>;
}

/** The preview behind a CONFIRM_REQUIRED / HAS_CHILDREN refusal. */
export interface DeletePreview {
  id: string;
  title: string;
  status: string;
  /** True for the online branch (cascade) — false for the local refusal. */
  online: boolean;
  /** Direct children (both branches). */
  children: Array<{ id: string; title: string }>;
  /** Transitive cone beyond the direct children (online only). */
  descendants: Array<{ id: string; title: string }>;
}

export interface DeleteTaskInput {
  /** Raw id or unique prefix, exactly as the flag carried it. */
  id: string;
  /** `--yes`: the deliberate human confirmation. */
  confirmed: boolean;
  dryRun?: boolean;
}

export interface DeleteTaskData {
  dryRun: boolean;
  id: string;
  /** Root first, then the online cone (local: exactly `[id]`). */
  deletedIds: string[];
  title: string;
}

/** The operation error, carrying the human preview beside the envelope. */
export interface DeleteTaskError {
  code: string;
  message: string;
  suggestion?: string;
  retryable?: boolean;
  /** Present on CONFIRM_REQUIRED / HAS_CHILDREN for the human block. */
  preview?: DeletePreview;
}

export type DeleteTaskResult =
  | { ok: true; data: DeleteTaskData; steps?: never; error?: never }
  | { ok: false; data?: never; steps?: never; error: DeleteTaskError };

export async function deleteTaskOperation(
  ctx: OperationContext,
  input: DeleteTaskInput,
): Promise<DeleteTaskResult> {
  const rawId = input.id;
  // The empty string prefixes every id: refuse it here — before either
  // store is read — so `--delete ""` cannot resolve to the whole board.
  if (rawId.length === 0) {
    return {
      ok: false,
      error: {
        code: "TASK_NOT_FOUND",
        message:
          "Task id must not be empty — pass a task id or unique prefix.",
        suggestion: "Run 'vibeflow tasks' to see available task IDs.",
      },
    };
  }

  const online = ctx.mode === "saas" && !ctx.store;
  // ONE row list for both stores (id/title/status/parent links), so
  // resolution and the child guard below run once, not per store.
  let rows: DeletePlanRow[];
  try {
    const { store } = resolveReadPorts(ctx);
    const all = await store.listTasks(ctx.projectDir);
    rows = all.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      links: (t.links ?? []).map((l) => ({ taskId: l.taskId, type: l.type })),
    }));
  } catch (err) {
    if (isRemoteReadError(err)) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: `Unable to read task ${rawId} from the online board (${err.message}).`,
          ...(err.suggestion ? { suggestion: err.suggestion } : {}),
          ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "DELETE_READ_ERROR",
        message: `Unable to read the task store: ${err instanceof Error ? err.message : String(err)}`,
        suggestion: "Check the project directory holds a readable store, then retry.",
      },
    };
  }

  // ONE resolver for both stores: an exact id wins (even when it prefixes
  // others), a unique prefix resolves, anything else is refused — never a
  // silent first-match.
  const resolved = resolveSaasTaskId(rows, rawId);
  if (!resolved.ok) {
    return {
      ok: false,
      error: {
        code: resolved.code,
        message:
          resolved.code === "TASK_NOT_FOUND"
            ? `Task not found: ${rawId}`
            : resolved.message,
        suggestion:
          resolved.code === "TASK_NOT_FOUND"
            ? "Run 'vibeflow tasks' to see available task IDs."
            : "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
      },
    };
  }
  const id = resolved.id;
  const found = rows.find((t) => t.id === id);
  const title = found?.title ?? "";
  const status = found?.status ?? "";
  const children = rows
    .filter((t) =>
      t.links.some((l) => l.type === "parent" && l.taskId === id),
    )
    .map((t) => ({ id: t.id, title: t.title }));
  // The online cone is transitive: the v0 DELETE cascades through the whole
  // subtree, so the warning names every descendant, not just the direct
  // children (BFS over the listed parent links — the listing is complete
  // because truncation fails the read).
  const descendants: Array<{ id: string; title: string }> = online
    ? (() => {
        const seen = new Set<string>([id]);
        const out: Array<{ id: string; title: string }> = [];
        const queue = [id];
        while (queue.length > 0) {
          const parent = queue.shift()!;
          for (const t of rows) {
            if (
              !seen.has(t.id) &&
              t.links.some((l) => l.type === "parent" && l.taskId === parent)
            ) {
              seen.add(t.id);
              out.push({ id: t.id, title: t.title });
              queue.push(t.id);
            }
          }
        }
        return out;
      })()
    : [];
  const preview: DeletePreview = { id, title, status, online, children, descendants };

  // Preview / confirmation gate: without --yes nothing is written.
  if (!input.confirmed) {
    const cascadeNote =
      online && descendants.length > 0
        ? ` — WARNING: the online delete CASCADES: ${descendants.length} descendant task${descendants.length === 1 ? "" : "s"} (${descendants.map((d) => d.id).join(", ")}) will be deleted with it`
        : "";
    const localNote =
      !online && children.length > 0
        ? ` — refused: it has ${children.length} child task${children.length === 1 ? "" : "s"} that would be left with a dangling parent link`
        : "";
    return {
      ok: false,
      error: {
        code: "CONFIRM_REQUIRED",
        message: `Would delete task ${id}${title ? ` "${title}"` : ""}${cascadeNote}${localNote}. Re-run with --yes to delete${!online && children.length > 0 ? " (after deleting the children first)" : ""}.`,
        suggestion: "Re-run with --yes to delete this task.",
        preview,
      },
    };
  }

  // Local parents refuse even WITH --yes: no cascade on this surface. Online
  // parents proceed (the server deletes the cone) — dry-run excepted, which
  // only ever reports. A dry run of a refused operation is the refusal.
  const localRefusal = !online && children.length > 0;
  if (isDryRun(ctx, input) && !localRefusal) {
    return {
      ok: true,
      data: {
        dryRun: true,
        id,
        deletedIds: online ? [id, ...descendants.map((d) => d.id)] : [id],
        title,
      },
    };
  }
  if (localRefusal) {
    return {
      ok: false,
      error: {
        code: "HAS_CHILDREN",
        message: `Cannot delete local task ${id}: it has ${children.length} child task${children.length === 1 ? "" : "s"} (${children.map((c) => c.id).join(", ")}) — the local store does not cascade, so deleting the parent would orphan them. Delete the children first (deepest first), then re-run with --yes.`,
        suggestion: "Delete the child tasks first, then delete this parent.",
        preview,
      },
    };
  }

  if (online) {
    const { deleteSaasTask } = await import("../../saas/client.js");
    const deleted = await deleteSaasTask(id);
    if (!deleted.ok) {
      if (deleted.error.code === "TASK_NOT_FOUND") {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${id}`,
            suggestion: "Run 'vibeflow tasks' to see available task IDs.",
          },
        };
      }
      const serverCode = deleted.error.serverCode;
      if (serverCode) {
        return {
          ok: false,
          error: { code: serverCode, message: deleted.error.message },
        };
      }
      const mapped = saasFailure(deleted.error);
      return {
        ok: false,
        error: {
          code: mapped.code,
          message: `Failed to delete task: ${id}`,
          ...(mapped.suggestion ? { suggestion: mapped.suggestion } : {}),
          retryable: mapped.retryable,
        },
      };
    }
    const deletedIds = deleted.data.deletedIds;
    // The local store is what push reads: a local row for a remotely-deleted
    // id would be re-pushed (recreated) on the next push, so every
    // remotely-deleted id is dropped locally too — best-effort, never fatal
    // to a delete that landed.
    for (const deletedLocalId of deletedIds) {
      try {
        await localTaskStore.deleteTask(ctx.projectDir, deletedLocalId);
      } catch {
        /* absent or raced — the remote delete already landed */
      }
    }
    return { ok: true, data: { dryRun: false, id, deletedIds, title } };
  }

  const removed = await localTaskStore.deleteTask(ctx.projectDir, id);
  // A miss here is a delete-between-resolve race: the row resolved above
  // and vanished before the write.
  if (!removed) {
    return {
      ok: false,
      error: {
        code: "TASK_NOT_FOUND",
        message: `Task not found: ${id}`,
        suggestion: "Run 'vibeflow tasks' to see available task IDs.",
      },
    };
  }
  return { ok: true, data: { dryRun: false, id, deletedIds: [id], title } };
}

