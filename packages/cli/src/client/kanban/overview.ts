import type { Task, TaskStatus } from "@vibeflow-tools/ui/kanban";

/**
 * WHAT: client-side board aggregates for the CLI kanban overview page.
 * WHY client-side, no new API (ticket 717d6335): the board shell already
 * fetches the full task list from GET /api/tasks for the columns, and the
 * overview derives every number from that same payload — a dedicated
 * summary endpoint would duplicate the list read for zero saved bytes on
 * a local board, so none was added. The page is READ-ONLY: it never
 * PATCHes/POSTs/DELETEs; card links jump back to `/kanban#task-<id>`.
 */

/**
 * Canonical column order (mirrors TASK_STATUSES in api-core mcp-tools —
 * duplicated, not imported, so the browser bundle stays free of CLI-core
 * server modules). Every status is always present in the output, even at
 * zero, so the status table never gains/loses rows between boards.
 */
export const OVERVIEW_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
] as const;

export interface OverviewStaleTask {
  id: string;
  title: string;
  status: TaskStatus;
  /** Whole days between creation and `now` (floor, never negative). */
  ageDays: number;
  /** ISO timestamp the age was measured from ("" when the task has none). */
  dateIso: string;
}

export interface OverviewAssigneeRow {
  name: string;
  total: number;
  open: number;
  done: number;
}

export interface BoardOverview {
  total: number;
  countsByStatus: Record<TaskStatus, number>;
  /** status === done and completion stamp falls on today's calendar day. */
  doneToday: number;
  /** status === done and completion stamp is within the last 7 days. */
  doneThisWeek: number;
  oldestTodo: OverviewStaleTask | null;
  oldestInProgress: OverviewStaleTask | null;
  /** By `author ?? authorName ?? "Unassigned"`, total desc then name asc. */
  assignees: OverviewAssigneeRow[];
}

type TaskWithLegacyDates = Task & { created?: string; updated?: string };

function createdIso(task: Task): string {
  const t = task as TaskWithLegacyDates;
  return task.createdAt ?? t.created ?? "";
}

function completedIso(task: Task): string {
  const t = task as TaskWithLegacyDates;
  // `updated`/`updatedAt` is bumped on every mutation including the move to
  // done, so it is the completion stamp; fall back to creation when absent
  // (legacy files predate the field) rather than dropping the task.
  return task.updatedAt ?? t.updated ?? createdIso(task);
}

function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function oldestIn(
  tasks: Task[],
  status: TaskStatus,
  nowMs: number,
): OverviewStaleTask | null {
  let best: OverviewStaleTask | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const task of tasks) {
    if (task.status !== status) continue;
    const iso = createdIso(task);
    const ms = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isNaN(ms)) continue;
    if (ms < bestMs) {
      bestMs = ms;
      best = {
        id: task.id,
        title: task.title,
        status,
        ageDays: Math.max(0, Math.floor((nowMs - ms) / 86_400_000)),
        dateIso: iso,
      };
    }
  }
  return best;
}

/** Aggregate one board snapshot. Pure — safe to unit test on fixtures. */
export function computeBoardOverview(
  tasks: Task[],
  now: Date = new Date(),
): BoardOverview {
  const countsByStatus: Record<TaskStatus, number> = {
    backlog: 0,
    todo: 0,
    "in-progress": 0,
    review: 0,
    done: 0,
  };
  for (const task of tasks) {
    if (task.status in countsByStatus) countsByStatus[task.status] += 1;
  }

  const todayStart = startOfToday(now).getTime();
  const weekStart = now.getTime() - 7 * 86_400_000;
  let doneToday = 0;
  let doneThisWeek = 0;
  for (const task of tasks) {
    if (task.status !== "done") continue;
    const ms = Date.parse(completedIso(task));
    if (Number.isNaN(ms)) continue;
    if (ms >= todayStart) doneToday += 1;
    if (ms >= weekStart) doneThisWeek += 1;
  }

  const byAssignee = new Map<string, OverviewAssigneeRow>();
  for (const task of tasks) {
    const name = task.author ?? task.authorName ?? "Unassigned";
    let row = byAssignee.get(name);
    if (!row) {
      row = { name, total: 0, open: 0, done: 0 };
      byAssignee.set(name, row);
    }
    row.total += 1;
    if (task.status === "done") row.done += 1;
    else row.open += 1;
  }
  const assignees = [...byAssignee.values()].sort(
    (a, b) => b.total - a.total || a.name.localeCompare(b.name),
  );

  return {
    total: tasks.length,
    countsByStatus,
    doneToday,
    doneThisWeek,
    oldestTodo: oldestIn(tasks, "todo", now.getTime()),
    oldestInProgress: oldestIn(tasks, "in-progress", now.getTime()),
    assignees,
  };
}
