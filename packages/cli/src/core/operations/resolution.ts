/**
 * Portable task resolution (ticket 3d613068).
 *
 * THE existence check for every task-scoped MCP mutation, now port-backed:
 * it resolves through the injected `TaskStore` and never touches a
 * filesystem path. Missing vs unreadable records stay distinguishable
 * (`TASK_NOT_FOUND` vs `TASK_READ_ERROR`) via the port's resolve outcome.
 *
 * Why a fourth tool cannot forget it:
 *  1. id resolution already lived in two places (`getTask`, `updateTask`) with
 *     the same prefix-tolerant rule — the PORT is that rule now, so there is
 *     one implementation of "what id does this mean", not three;
 *  2. every mutating tool takes the RESOLVED `id` from here, never the raw
 *     input, so a tool cannot even name a path it has not resolved;
 *  3. `tests/e2e/mcp-mutation-refusal-guard.test.ts` enumerates the manifest's
 *     task-write tools and sweeps each with an id that cannot exist, so a NEW
 *     mutating tool is covered by the manifest sweep the day it is added —
 *     a fourth tool cannot be added without the guard seeing it.
 */
import type { Task } from "../../core/types.js";
import type {
  OperationContext,
  OperationError,
} from "../../core/operations.js";
import { resolveOperationPorts } from "../../core/task-store.js";

/**
 * The ONE `TASK_NOT_FOUND` recovery text, shared by every tool that returns
 * that code. It used to exist on `get_task` alone, so the same code carried two
 * different suggestions depending on which tool refused — a client could not
 * learn the recovery once and apply it everywhere. One constant is the fix.
 */
export const TASK_NOT_FOUND_SUGGESTION =
  "List the board to get a real id (list_tasks on MCP, 'vibeflow tasks' on the CLI) — a full id or a unique prefix both resolve.";

export type TaskResolution =
  | { ok: true; id: string; task: Task }
  | { ok: false; error: OperationError };

/**
 * Resolve a task id to the task it names, or refuse `TASK_NOT_FOUND` /
 * `TASK_READ_ERROR`.
 *
 * P1 shape: the port decides found/missing/unreadable. No `filePath` is
 * returned — portable resolution must not need a filesystem path (callers
 * that needed the path were migrated to artifact-port reads in P1; none
 * remain in the operation layer).
 */
export async function resolveTaskOrRefusal(
  ctx: OperationContext,
  idOrPrefix: string,
): Promise<TaskResolution> {
  const { store } = resolveOperationPorts(ctx);
  const outcome = await store.resolveTask(ctx.projectDir, idOrPrefix);
  if (outcome.status === "missing") {
    return {
      ok: false,
      error: {
        code: "TASK_NOT_FOUND",
        message: `Task not found: ${outcome.id}`,
        suggestion: TASK_NOT_FOUND_SUGGESTION,
      },
    };
  }
  if (outcome.status === "unreadable") {
    // The record exists but does not parse — a different problem with a
    // different fix, so it is a different code. Kept distinct from
    // TASK_NOT_FOUND by every task-scoped tool so one consumer can branch
    // on it.
    return {
      ok: false,
      error: {
        code: "TASK_READ_ERROR",
        message: `Failed to read task: ${outcome.id}`,
        suggestion:
          "The task file exists but did not parse — check it is valid JSON, or re-create the task",
      },
    };
  }
  return { ok: true, id: outcome.id, task: outcome.task };
}
