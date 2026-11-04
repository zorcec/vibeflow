/**
 * Shared fuzzy search matcher (ticket mq8azbxthl824162fnr4at49).
 *
 * The SINGLE ranker for every in-process search surface: CLI local,
 * CLI remote (client-side final rank after the `q` narrowing fetch),
 * MCP (same operation as the CLI), and the web tRPC + v0 list reads
 * (server-side, after the bounded SQL prefilter). Ranking stays identical
 * on all of them BY CONSTRUCTION — every surface calls `rankFuzzySearch`
 * and sorts by (score asc, id asc) — never by its own listing order, so
 * parity does not depend on SQL ordering (parity > SQL-native ordering).
 *
 * Deliberately NOT a bespoke scorer: no per-field weights, no TF-IDF, no
 * tuning knobs. One algorithm — ordered-subsequence match per query token
 * (AND semantics: every token must match somewhere), cost = match start +
 * gap chars (earlier + tighter wins), summed over tokens. A typo-tolerant
 * substring search, nothing more.
 *
 * Node-free (pure string ops) so the CLI browser overlay bundle and the
 * web server can both import it — keep it that way (no node: imports).
 */

/** Max query length accepted by every surface (mirrors web SEARCH_TERM_MAX). */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/** Max rows a bounded SQL prefetch may hand the matcher (web tRPC + v0). */
export const SEARCH_PREFETCH_CAP = 1000;

/**
 * The effective sort applied to every search answer, in the `key:direction`
 * form the list `order` fields echo — so a caller can see the page is a
 * relevance ranking, not the listing order.
 */
export const SEARCH_ORDER: readonly string[] = ["score:asc", "id:asc"];

/** Searchable text of one task, as each surface's row shape provides it. */
export interface FuzzyHaystack {
  title?: string | null;
  description?: string | null;
  tags?: readonly (string | null | undefined)[] | null;
  /** Plain comment bodies (already extracted from the row shape). */
  comments?: readonly (string | null | undefined)[] | null;
}

/** Split a raw query into lowercase AND-tokens. Blank query → []. */
export function tokenizeSearchQuery(term: string): string[] {
  return term
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Cost of matching one token as an ordered subsequence of one field
 * (both already lowercased). Tries every occurrence of the token's first
 * char as the match start and keeps the cheapest (start index + gap chars
 * skipped between matched chars) — earlier + tighter wins. Null when the
 * token is not a subsequence of the field.
 */
function matchTokenCost(token: string, field: string): number | null {
  let best: number | null = null;
  for (let s = 0; s < field.length; s++) {
    if (field[s] !== token[0]) continue;
    let ti = 0;
    let gaps = 0;
    let prev = -1;
    for (let i = s; i < field.length && ti < token.length; i++) {
      if (field[i] === token[ti]) {
        if (prev >= 0) gaps += i - prev - 1;
        prev = i;
        ti++;
      }
    }
    if (ti === token.length) {
      const cost = s + gaps;
      if (best === null || cost < best) best = cost;
      if (best === 0) break;
    }
  }
  return best;
}

/**
 * Score one haystack against already-tokenized query tokens. The token
 * cost is the MINIMUM over the four scope fields (title, description,
 * tags, comments) — scope without weights: a match anywhere counts, the
 * best field wins. Null when any token matches nowhere (AND semantics).
 * Lower is better.
 */
export function fuzzyScoreTokens(
  tokens: readonly string[],
  hay: FuzzyHaystack,
): number | null {
  const fields = [
    hay.title ?? "",
    hay.description ?? "",
    (hay.tags ?? []).filter((t): t is string => typeof t === "string").join(" "),
    (hay.comments ?? [])
      .filter((t): t is string => typeof t === "string")
      .join("\n"),
  ].map((f) => f.toLowerCase());
  let total = 0;
  for (const rawToken of tokens) {
    // Defensive: callers pass tokenizeSearchQuery output (already lower),
    // but a raw mixed-case token must still match, not silently miss.
    const token = rawToken.toLowerCase();
    let best: number | null = null;
    for (const field of fields) {
      if (field.length === 0) continue;
      const cost = matchTokenCost(token, field);
      if (cost !== null && (best === null || cost < best)) {
        best = cost;
        if (best === 0) break;
      }
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/** One ranked hit: the original item plus its deterministic rank key. */
export interface FuzzyHit<T> {
  item: T;
  /** The task id (tiebreak + identity). */
  id: string;
  /** Lower ranks first. */
  score: number;
}

/**
 * Rank items by the shared fuzzy matcher. Returns hits sorted by
 * (score asc, id asc) — the SAME order on every surface. Blank query
 * returns every item scored at 0 (callers treat blank as "no search").
 */
export function rankFuzzySearch<T>(
  term: string,
  items: readonly T[],
  pick: (item: T) => { id: string } & FuzzyHaystack,
): Array<FuzzyHit<T>> {
  const tokens = tokenizeSearchQuery(term);
  const hits: Array<FuzzyHit<T>> = [];
  for (const item of items) {
    const hay = pick(item);
    if (tokens.length === 0) {
      hits.push({ item, id: hay.id, score: 0 });
      continue;
    }
    const score = fuzzyScoreTokens(tokens, hay);
    if (score !== null) hits.push({ item, id: hay.id, score });
  }
  hits.sort((a, b) => a.score - b.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hits;
}
