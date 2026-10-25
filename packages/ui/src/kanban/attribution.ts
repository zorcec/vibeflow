/**
 * Shared authorship attribution (ticket 0b7c45c5 — "Agent icon").
 *
 * ONE rule for every surface, both boards: render the HUMAN behind the
 * row, and add an agent badge when the change came from an agent surface.
 * The card, the details tab and the activity feed all read through
 * `resolveAttribution`, so the same record renders the same attribution
 * everywhere — the flip the owner reported (bare '🤖 Agent' in three
 * places, bare human in two, plus a live-vs-refetch flip on the card)
 * cannot come back through a second local conditional.
 *
 * Server-safe AND client-safe: pure strings, no imports.
 *
 * What counts as agent evidence (never a name heuristic — read paths must
 * not infer anything from display names):
 *   - the stored comment vocabulary 'agent' (preserved verbatim end to end)
 *   - an explicit `agent: true` flag set where the actor is known
 *     (live change rows, assignee patch — in-memory only, no migration)
 *   - the ephemeral agent marker itself ('🤖 Agent')
 * Anything else — including `source: 'cli'` and the task `agent` column
 * (accepted on input, never rendered, never read here) — is NOT agent
 * evidence on its own.
 *
 * Honesty rule: agent-ness that cannot be proven renders NO badge. A row
 * whose vocabulary/flag proves an agent but names no human renders the
 * marker with an "Unknown" human — the badge is honest there, the name
 * is not invented.
 */
export const AGENT_COMMENT_AUTHOR = "agent";
export const API_COMMENT_AUTHOR = "API";
export const AGENT_ACTOR_MARKER = "🤖 Agent";
export const API_ACTOR_MARKER = "API";

/** Callers that still need the stored-vocabulary check read it here. */
export function isAgentVocabulary(author: unknown): boolean {
  return author === AGENT_COMMENT_AUTHOR || author === AGENT_ACTOR_MARKER;
}

export type AttributionKind = "agent" | "api" | "human" | "unknown";

export interface AttributionSource {
  /** Stored vocabulary ('user'|'agent'|'API'), the live-update marker, or a legacy display name. */
  author?: string | null;
  /** Human display name when known (joined from the author record, or the local user). */
  authorName?: string | null;
  /** Explicit agent-involvement flag — set where the actor is known, never inferred. */
  agent?: boolean | null;
  /** Viewer/local-user fallback when the record names nobody (comments only). */
  viewer?: string | null;
  /**
   * Origin platform ('cli' = CLI command, 'web' = web app). Accepted so
   * callers can pass rows through untouched — it is NOT agent evidence
   * (origin has its own indicator) and never affects the result.
   */
  source?: "cli" | "web";
}

export interface ResolvedAttribution {
  kind: AttributionKind;
  /** Display name of the human behind the row, or null when unknown. */
  human: string | null;
  /** True exactly when kind === 'agent' — the badge gate. */
  isAgent: boolean;
}

function cleanName(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

export function resolveAttribution(s: AttributionSource): ResolvedAttribution {
  const author = s.author ?? null;
  // API rows keep their legacy rendering (distinct marker, out of scope).
  if (author === API_COMMENT_AUTHOR || author === API_ACTOR_MARKER) {
    return { kind: "api", human: cleanName(s.authorName) ?? author, isAgent: false };
  }
  const explicitAgent = s.agent === true;
  const vocabAgent = isAgentVocabulary(author);
  if (explicitAgent || vocabAgent) {
    // With the flag the author string IS the resolved human (append sites
    // resolve it before storing); the marker alone names nobody.
    const fromAuthor = explicitAgent && !isAgentVocabulary(author) ? cleanName(author) : null;
    const human = cleanName(s.authorName) ?? fromAuthor ?? cleanName(s.viewer);
    return { kind: "agent", human, isAgent: true };
  }
  // Human rows keep the exact old precedence: joined name, legacy display
  // name carried in `author`, then the viewer — never anyone else.
  const legacyName =
    author !== null && author !== "user" && !isAgentVocabulary(author) ? cleanName(author) : null;
  const human = cleanName(s.authorName) ?? legacyName ?? cleanName(s.viewer);
  if (human === null) return { kind: "unknown", human: null, isAgent: false };
  return { kind: "human", human, isAgent: false };
}

/**
 * Stable group key for consecutive same-attribution rows. Agent rows group
 * by their human (plus kind, so a marker-only row never merges into a
 * named row) — grouping follows the rendered attribution, never the raw
 * actor string, or the feed would re-split what it just unified.
 */
export function attributionGroupKey(a: ResolvedAttribution): string {
  return `${a.kind}:${a.human ?? ""}`;
}
