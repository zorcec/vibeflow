/**
 * Client-side board search — the ONE match predicate shared by the board,
 * the list view, and the header count (ticket 46e05c7b).
 *
 * SEMANTICS (pinned by search.test.ts — this ticket changes SHAPE, not
 * behaviour): case-insensitive `String.includes` over title + description,
 * run over the tasks already fetched. An empty query matches everything.
 * There is deliberately NO fuzziness here: nothing was fuzzy before this
 * extraction, and changing matching semantics is a product decision, not a
 * refactor. Multi-term queries are a CONTIGUOUS substring — "a b" matches
 * "a b" but NOT "a x b".
 *
 * Every consumer that filters tasks by the search box MUST go through
 * {@link taskMatchesQuery} / {@link filterTasksByQuery} so the board list
 * and the header "N of M tasks" count can never disagree again.
 */

/** Minimal shape the predicate needs — both Task flavours satisfy this. */
export interface SearchableTask {
  title?: string | null;
  description?: string | null;
}

/**
 * DECISION (46e05c7b): the search input re-filtered and re-rendered the
 * whole board on EVERY keystroke. The filter itself is a cheap in-memory
 * scan, so the cost was React re-render churn, not the match — a short
 * debounce collapses fast-typing bursts without feeling laggy.
 * WHAT 150ms trailing debounce on the query propagated to the board/list.
 * WHY `useDebouncedValue` (this package) — keeps the input echo instant
 * while the expensive re-render waits for a typing pause.
 * WHO+WHEN lane worker, 2026-10-17, ticket 46e05c7b.
 * IMPACT ~150ms after the last keystroke the board/header settle; existing
 * e2e waits (300-500ms) still pass. Product call if a different delay or
 * no delay is wanted. NOT the same as the web app's server-search
 * `SEARCH_DEBOUNCE_MS` (= 1000, ticket e6066327): same export name,
 * different mechanism — this one debounces a free in-memory re-render,
 * that one a server round trip. Do not "sync" the numbers without
 * re-measuring both; aligning them makes one surface laggy or chatty.
 */
export const SEARCH_DEBOUNCE_MS = 150;

/**
 * True when `task` matches the raw search-box `query`. Empty query matches
 * everything (mirrors the previous `searchQuery ? filter : tasks` ternaries).
 */
export function taskMatchesQuery(
  task: SearchableTask,
  query: string,
): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    (task.title ?? "").toLowerCase().includes(needle) ||
    (task.description ?? "").toLowerCase().includes(needle)
  );
}

/** Filter `tasks` by the raw search-box `query` — empty query returns all. */
export function filterTasksByQuery<T extends SearchableTask>(
  tasks: readonly T[],
  query: string,
): T[] {
  if (!query) return tasks.slice();
  return tasks.filter((t) => taskMatchesQuery(t, query));
}
