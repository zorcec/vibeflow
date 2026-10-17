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
 * - limit: >0 slices (truncated:true + hint); <=0/NaN/undefined resolves to
 *   DEFAULT_LIST_LIMIT with a `limitNotice` when the caller passed the bad
 *   value explicitly (ticket b2e56212) — there is NO unbounded mode.
 *   Getting everything is explicit paging (`queryAllTasks`, CLI `--all`).
 */

import type { Task } from "./types.js";
import { isChildTask } from "./tasks.js";
import { getPriorityRank } from "./types.js";
import { DEFAULT_LIST_LIMIT } from "@vibeflow-tools/api-core";

/**
 * Resolve a raw CLI `--limit` string to an effective limit. A missing flag
 * resolves to DEFAULT_LIST_LIMIT — the SAME exported constant the MCP
 * `limit` schema defaults to — so the two surfaces cannot drift apart: a
 * future change to the number changes both by construction.
 *
 * WHAT/WHY (ticket b2e56212, owner decision): `0 = all` is gone. `0` (like
 * any <=0/NaN value) is a private convention inverting the standard one
 * (SQL's `LIMIT 0` returns ZERO rows); on the real board it is 1,427 roots
 * at ~3.6 KB/task — ~5 MB / ~1.3M tokens — and the old response `hint` was
 * RECOMMENDING it. An unbounded mode is exactly what later gets capped,
 * and capped SILENTLY (bug e07c8212's entire family). So a present-but-bad
 * value falls back to the default here, and queryTaskList names the
 * fallback in `limitNotice` — never a silent reinterpretation. Getting
 * everything is explicit paging (CLI `--all` / `queryAllTasks`), not a
 * magic value.
 */
export function resolveListLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT;
  return parsed;
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
  /**
   * Max rows to return. A positive number slices; <=0/NaN/undefined
   * resolves to DEFAULT_LIST_LIMIT (ticket b2e56212 — no unbounded mode).
   * An EXPLICIT bad value (0 included) is named in `limitNotice`.
   */
  limit?: number;
  /**
   * 0-based offset of the first row to return (paging). Default 0: no
   * `cursor` input exists yet, so a plain listing starts at the head.
   * `queryAllTasks` advances this internally to page the whole set.
   */
  offset?: number;
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
  /**
   * Effective limit, ECHOED RESOLVED (ticket b2e56212): never 0 — an
   * explicit `limit: 0` (or any <=0/NaN/undefined) resolves to
   * DEFAULT_LIST_LIMIT and the fallback is named in `limitNotice`.
   */
  limit: number;
  /**
   * Present ONLY when the caller passed an explicit bad limit (0 included)
   * that was resolved to the default: names what happened
   * ("limit 0 is not supported — applied the default of 20; page with
   * nextCursor"), so a caller whose intent was "everything" learns it got
   * a page, not the board. Absent for omitted/in-range limits — omitting
   * the parameter is the normal path and needs no apology.
   */
  limitNotice?: string;
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
   * Rows in THIS query's scope NOT in this response; 0 means exhausted.
   * WHAT/WHY (ticket b2e56212 — a DELIBERATE REVERSAL of the 9bb350a7
   * corner, which counted hidden children here): `remaining` is
   * SCOPE-AWARE — `remaining = scopeRows - offset - returned`, where
   * `scopeRows` is `totalRoots` for a root-only listing and `totalMatching`
   * otherwise (children:true, or a filtered search). The old definition
   * counted child rows the query could never return, so `remaining`
   * OVERSTATED the remaining work by exactly `hiddenChildren` while `hint`
   * truthfully reported the root scope — two fields in one response
   * disagreeing, with the trusted one wrong. The invariant is now
   * `offset + returned + remaining === scopeRows`. `totalMatching` /
   * `totalRoots` / `hiddenChildren` are untouched — they stay
   * unscoped-truthful. A scope-hiding-but-limit-exhausted page (root-only
   * with children present, limit not cutting) reports remaining === 0 with
   * nextCursor === null — the hidden rows are disclosed via hiddenChildren
   * and revealed with children:true, not via a cursor, because a cursor
   * continues THIS query's ordering and the same query would return the
   * same rows.
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

  // Ticket b2e56212: NO unbounded mode. A positive limit slices; anything
  // else (0 included, NaN included, omitted) resolves to DEFAULT_LIST_LIMIT
  // — EXACTLY like omitting the parameter — with normal truncation metadata
  // and a live cursor. WHY (owner decision, verbatim scope): `0 = all` is a
  // private convention inverting the standard one (SQL's `LIMIT 0` returns
  // ZERO rows); on the real board it is 1,427 roots at ~3.6 KB/task — ~5 MB
  // / ~1.3M tokens — and the old `hint` was RECOMMENDING it; and an
  // unbounded mode is exactly what later gets capped, and capped SILENTLY
  // (bug e07c8212's entire family). The fallback is NEVER silent: an
  // explicitly passed bad value is named in `limitNotice`.
  const requested = query.limit;
  const fellBack = !(
    typeof requested === "number" &&
    Number.isFinite(requested) &&
    requested > 0
  );
  const limit = fellBack ? DEFAULT_LIST_LIMIT : Math.floor(requested as number);
  const rawOffset = query.offset;
  const offset =
    typeof rawOffset === "number" &&
    Number.isFinite(rawOffset) &&
    rawOffset > 0
      ? Math.floor(rawOffset)
      : 0;
  const truncated = sorted.length > offset + limit;
  const tasks = sorted.slice(offset, offset + limit);

  // Position metadata (ticket 9bb350a7, scope rule revised b2e56212):
  // offset/remaining/nextCursor/order are computed from the SAME locals as
  // the counts above — free, no extra query, no extra file read. The cursor
  // encodes where THIS page stopped. `remaining` is scope-aware: the
  // root-only listing can only ever return roots, so it counts down from
  // totalRoots, and `hint` (which reports the same scope) AGREES with it.
  const scopeRows = includeChildren ? totalMatching : totalRoots;
  const remaining = Math.max(0, scopeRows - offset - tasks.length);
  const nextCursor = truncated
    ? encodeListCursor(offset + tasks.length)
    : null;

  return {
    tasks,
    totalMatching,
    totalRoots,
    hiddenChildren,
    returned: tasks.length,
    limit,
    ...(fellBack && requested !== undefined
      ? {
          limitNotice: `limit ${String(requested)} is not supported — applied the default of ${DEFAULT_LIST_LIMIT}; page with nextCursor`,
        }
      : {}),
    truncated,
    ...(truncated
      ? {
          hint: `showing ${tasks.length} of ${scopeRows} matching — page with nextCursor (CLI: --all fetches everything)`,
        }
      : {}),
    offset,
    remaining,
    nextCursor,
    order: [...LIST_ORDER],
  };
}

/**
 * The EXPLICIT paged helper (ticket b2e56212): fetch the whole matching
 * set with BOUNDED requests — each page is at most `pageSize` rows
 * (DEFAULT_LIST_LIMIT unless given), advancing `offset` via the same
 * `nextCursor` contract a remote caller pages with. Unbounded overall,
 * bounded per request; the server never materialises the full set in one
 * read. Anything internal that truly needs the whole board (CLI `--json`,
 * `--all`) comes through HERE — never through the `limit: 0` magic value.
 *
 * The answer is shaped like an exhausted page: `truncated: false`,
 * `remaining: 0`, `nextCursor: null`, `limit` echoing the page size used.
 */
export function queryAllTasks<T extends Task>(
  all: T[],
  query: Omit<TaskListQuery, "limit" | "offset"> & { pageSize?: number },
): TaskListResult<T> {
  const { pageSize: rawPageSize, ...rest } = query;
  const pageSize =
    typeof rawPageSize === "number" &&
    Number.isFinite(rawPageSize) &&
    rawPageSize > 0
      ? Math.floor(rawPageSize)
      : DEFAULT_LIST_LIMIT;
  const collected: T[] = [];
  let offset = 0;
  let last: TaskListResult<T> | null = null;
  for (;;) {
    const page = queryTaskList(all, { ...rest, limit: pageSize, offset });
    last = page;
    collected.push(...page.tasks);
    // A live cursor with an empty page would loop forever — treat it as
    // exhausted rather than spinning (defensive; cannot happen while the
    // cursor encodes offset + returned, but the loop must not trust that).
    if (page.nextCursor === null || page.tasks.length === 0) break;
    offset += page.tasks.length;
  }
  const base = last as TaskListResult<T>;
  return {
    ...base,
    tasks: collected,
    returned: collected.length,
    limit: pageSize,
    truncated: false,
    offset: 0,
    remaining: 0,
    nextCursor: null,
    order: [...LIST_ORDER],
  };
}
