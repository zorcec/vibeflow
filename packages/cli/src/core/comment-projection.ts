/**
 * One comment-prose projection for the hosted/local spelling split
 * (ticket 20c68ebb6db1ff68).
 *
 * The hosted record spells the comment field `body` (the DB column) while
 * the local record and the v0 contract spell it `text`. Both spellings
 * travel the same wire at different points — a detail response inlines the
 * stored `body` rows, a comments endpoint answers contract `text` rows —
 * so every projection reads both and neither side of the mapping drops
 * the prose. Callers: `toSaasComment` (`saas/client.ts`, local -> hosted)
 * and `toLocalTask` / its record candidate / `toLocalComment`
 * (`core/remote-task-store.ts`, hosted -> local).
 *
 * Rules, all fail-closed:
 * - `text` is the canonical display spelling (local records and the v0
 *   contract share it); `body` is the hosted-storage alias. A row carrying
 *   both (never produced today) resolves to `text`.
 * - A row carrying neither resolves to `undefined` — the field stays
 *   absent. Nothing here invents prose, falls back to a hard-coded string,
 *   or stringifies absence into `"undefined"`. An empty string is real
 *   data and passes through untouched.
 */
export interface CommentTextRow {
  readonly text?: unknown;
  readonly body?: unknown;
}

export function projectCommentText(
  row: CommentTextRow | null | undefined,
): string | undefined {
  if (row === null || row === undefined) return undefined;
  if (typeof row.text === "string") return row.text;
  if (typeof row.body === "string") return row.body;
  return undefined;
}
