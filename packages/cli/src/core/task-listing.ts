/**
 * Shared task-listing model — the ONE place filter/scope/sort/limit/counts
 * are decided, used by both the CLI `tasks` listing and the MCP `list_tasks`
 * tool (parity contract 83159002: the two surfaces render one underlying
 * result model so they cannot drift again).
 *
 * Semantics are the CLI's (the reference surface):
 * - filters: status exact, type case-insensitive, user trim+case-insensitive,
 *   tag every-match;
 * - scope: root-only by default, BUT a filtered query (status/type/user/tag)
 *   is an explicit search and includes children, so a matching task can never
 *   be invisible because its parent did not match. `--children`/`children:true`
 *   includes children in the unfiltered listing too;
 * - order: kanban status rank, then priority rank, then updated/created
 *   newest-first, then id;
 * - limit: >0 slices (truncated:true + hint), <=0/undefined means all.
 */

import type { Task } from "./types.js";
import { isChildTask } from "./tasks.js";
import { getPriorityRank } from "./types.js";

/** Filter/scope input — the same fields on both surfaces. */
export interface TaskListQuery {
  status?: string;
  type?: string;
  user?: string;
  tag?: string[];
  /** Include children in the unfiltered listing (CLI --children). */
  children?: boolean;
  /** Max rows to return. <=0 or undefined means no limit. */
  limit?: number;
}

/** One listing answer, with every count labelled by scope. */
export interface TaskListResult<T extends Task = Task> {
  /** Rows to render/return (post-scope, sorted, post-limit). */
  tasks: T[];
  /** Every task matching the filters, children included. */
  totalMatching: number;
  /** Matching tasks with no parent (the peer rows of a root-only listing). */
  totalRoots: number;
  /** Matching children omitted by root-only scope (0 when included). */
  hiddenChildren: number;
  /** Rows actually in `tasks` (post-limit). */
  returned: number;
  /** Effective limit (0 = unlimited). */
  limit: number;
  /** True when the limit cut rows off. */
  truncated: boolean;
  /** Present only when truncated: how to see the rest. */
  hint?: string;
}

/** Kanban column order: in-progress → review → todo → backlog → done. */
const KANBAN_STATUS_ORDER = [
  "in-progress",
  "review",
  "todo",
  "backlog",
  "done",
] as const;

function getStatusRank(status: string): number {
  const idx = KANBAN_STATUS_ORDER.indexOf(
    status as (typeof KANBAN_STATUS_ORDER)[number],
  );
  return idx === -1 ? KANBAN_STATUS_ORDER.length : idx;
}

const normalizeFilterValue = (value: string): string =>
  value.trim().toLowerCase();

/** Board order shared by the CLI listing and the MCP tool. */
export function sortTasksForListing<T extends Task>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const byStatus = getStatusRank(a.status) - getStatusRank(b.status);
    if (byStatus !== 0) return byStatus;
    const byPriority =
      getPriorityRank(a.priority) - getPriorityRank(b.priority);
    if (byPriority !== 0) return byPriority;

    const aDate = new Date(a.updated ?? a.created).getTime();
    const bDate = new Date(b.updated ?? b.created).getTime();
    if (aDate !== bDate) return bDate - aDate;

    return a.id.localeCompare(b.id);
  });
}

/**
 * Filter + scope + sort + limit in one pass. Pure: takes the store's tasks,
 * returns the labelled answer. Both surfaces must call this (not a copy).
 */
export function queryTaskList<T extends Task>(
  all: T[],
  query: TaskListQuery,
): TaskListResult<T> {
  let filtered = all;
  if (query.status) {
    filtered = filtered.filter((t) => t.status === query.status);
  }
  if (query.type) {
    const want = query.type.toLowerCase();
    filtered = filtered.filter(
      (t) => (t.type ?? "Task").toLowerCase() === want,
    );
  }
  if (query.user) {
    const want = normalizeFilterValue(query.user);
    if (want) {
      filtered = filtered.filter(
        (t) => normalizeFilterValue(t.author ?? "") === want,
      );
    }
  }
  if (query.tag && query.tag.length > 0) {
    filtered = filtered.filter((t) =>
      query.tag!.every((tag) => (t.tags ?? []).includes(tag)),
    );
  }

  const totalMatching = filtered.length;
  const totalRoots = filtered.filter((t) => !isChildTask(t)).length;

  // Root-only is the default (board parity), but a filtered query is an
  // explicit search: it returns EVERY matching task, children included.
  const hasSearchFilter = Boolean(
    query.status ||
      query.type ||
      (query.user && normalizeFilterValue(query.user)) ||
      (query.tag && query.tag.length > 0),
  );
  const includeChildren = Boolean(query.children) || hasSearchFilter;
  const hiddenChildren = includeChildren
    ? 0
    : filtered.filter(isChildTask).length;
  const scoped = includeChildren
    ? filtered
    : filtered.filter((t) => !isChildTask(t));

  const sorted = sortTasksForListing(scoped);

  const limit = query.limit ?? 0;
  const truncated = limit > 0 && sorted.length > limit;
  const tasks = truncated ? sorted.slice(0, limit) : sorted;

  return {
    tasks,
    totalMatching,
    totalRoots,
    hiddenChildren,
    returned: tasks.length,
    limit: limit > 0 ? limit : 0,
    truncated,
    ...(truncated
      ? {
          hint: `showing ${limit} of ${sorted.length} matching — use limit 0 for all`,
        }
      : {}),
  };
}
