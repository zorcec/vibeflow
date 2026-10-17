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
import { DEFAULT_LIST_LIMIT } from "@vibeflow-tools/api-core";

/**
 * Resolve a raw CLI `--limit` string to an effective limit. A missing flag
 * resolves to DEFAULT_LIST_LIMIT — the SAME exported constant the MCP
 * `limit` schema defaults to — so the two surfaces cannot drift apart: a
 * future change to the number changes both by construction. Present (even
 * unparsable) values keep the historical parseInt behaviour exactly
 * (NaN/<=0 means unlimited downstream in queryTaskList).
 */
export function resolveListLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  return parseInt(raw, 10);
}

/**
 * The effective sort applied to every listing, in the `key:direction` form
 * the `order` response field carries. Read off sortTasksForListing below —
 * if the comparator gains a key, add it here in the same position:
 * kanban status rank ascending, priority rank ascending (Critical first),
 * `updated` (falling back to `created` when absent) newest-first, id
 * ascending as the final tiebreak.
 */
export const LIST_ORDER: readonly string[] = [
  "status:asc",
  "priority:asc",
  "updated:desc",
  "id:asc",
];

/**
 * Opaque continuation cursor for a truncated listing: encodes the offset of
 * the first row NOT in this response. Opaque by contract — callers test
 * only null-ness — but decodable locally via decodeListCursor, so a future
 * `cursor` input can resume exactly where this page stopped.
 */
export function encodeListCursor(nextOffset: number): string {
  return Buffer.from(`vibeflow-list-cursor:${nextOffset}`, "utf8").toString(
    "base64url",
  );
}

/** Decode an encodeListCursor token back to its offset; null when foreign. */
export function decodeListCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const m = /^vibeflow-list-cursor:(\d+)$/.exec(raw);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

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
  /**
   * 0-based index of the FIRST returned row ("where the selector is").
   * Always 0: no `cursor` input exists yet, so every listing starts at the
   * head. Kept on the wire so a future cursor page can report its position.
   */
  offset: number;
  /**
   * Matching rows NOT in this response — rows cut by the limit AND rows
   * hidden by root-only scope alike; 0 means exhausted. Truncated
   * invariant: offset + returned + remaining === totalMatching. Corner, by
   * construction: a scope-hiding-but-limit-exhausted page (unfiltered
   * root-only with children present, limit not cutting) reports
   * remaining === hiddenChildren with nextCursor === null — the hidden rows
   * are disclosed via hiddenChildren and revealed with children:true, not
   * via a cursor, because a cursor continues THIS query's ordering and the
   * same query would return the same rows.
   */
  remaining: number;
  /**
   * Opaque continuation for the next page; null exactly when this query's
   * ordering is exhausted. A caller must never see remaining === 0 together
   * with a live cursor — and conversely a null cursor with remaining > 0
   * means "more exists under a different scope flag" (see `remaining`).
   */
  nextCursor: string | null;
  /**
   * The effective sort actually applied (LIST_ORDER) — the caller knows a
   * continuation is meaningful because the sequence is stable.
   */
  order: string[];
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

  // Position metadata (ticket 9bb350a7): offset/remaining/nextCursor/order
  // are computed from the SAME locals as the counts above — free, no extra
  // query, no extra file read. No cursor input exists yet, so offset is
  // always 0 and the cursor encodes where THIS page stopped.
  const offset = 0;
  const remaining = totalMatching - offset - tasks.length;
  const nextCursor = truncated
    ? encodeListCursor(offset + tasks.length)
    : null;

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
    offset,
    remaining,
    nextCursor,
    order: [...LIST_ORDER],
  };
}
