import type { Task } from "./types";

/**
 * Field-level activity entries for the detail-pane feed (`#dp-activity-pane`,
 * ticket 3647a4715eeebe2a2ce02571a58c91).
 *
 * ONE small entry per save: which field changed, never a value dump. Fields
 * whose values are short keep the feed's established from→to pills
 * (status/title/type/priority/verify); long or structural fields
 * (description/tags/relations) render name-only — see MINIMAL_FIELDS, read
 * by `CommentsList` when it renders `change` rows.
 *
 * Both kanban hosts (CLI board, hosted web) AND the local DetailPanel
 * record changes through this module, so an agent/MCP write reads exactly
 * like a UI write (parity contract): same field names, same minimal shape.
 */

/** One field that changed between two task snapshots. */
export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

/**
 * Fields that render WITHOUT old/new values (description text and
 * tag/link sets would be a diff dump, not a minimal entry).
 */
export const MINIMAL_FIELDS: ReadonlySet<string> = new Set([
  "description",
  "tags",
  "relations",
]);

/** Feed label for the `verified` tri-state (matches VerifyIndicator). */
export function verifyLabel(v: unknown): string {
  if (v === true) return "verified";
  if (v === false) return "failed";
  return "none";
}

/** Canonical comparable string for a tag set (order-insensitive). */
export function tagSetKey(tags: unknown): string {
  if (!Array.isArray(tags)) return "";
  return tags
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .sort()
    .join(",");
}

/** Canonical comparable string for a link set (order-insensitive). */
export function linkSetKey(links: unknown): string {
  if (!Array.isArray(links)) return "";
  const keys: string[] = [];
  for (const l of links) {
    if (
      typeof l === "object" &&
      l !== null &&
      typeof (l as { taskId?: unknown }).taskId === "string" &&
      typeof (l as { type?: unknown }).type === "string"
    ) {
      keys.push(
        `${(l as { type: string }).type}:${(l as { taskId: string }).taskId}`,
      );
    }
  }
  return keys.sort().join(",");
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Diff the activity-relevant details fields between two task snapshots.
 * Returns at most one entry per changed field, in Details-tab order.
 *
 * `branchName` folds into the status entry on purpose: the only UI path
 * that writes it (Apply & Review) always changes status in the same save,
 * and one save must read as ONE event. A standalone branchName write
 * (CLI/MCP only) still yields its own entry.
 */
export function diffTaskFields(
  prev: Partial<Task> | null | undefined,
  next: Partial<Task> | null | undefined,
): FieldChange[] {
  if (!prev || !next) return [];
  const out: FieldChange[] = [];
  const titlePrev = text(prev.title);
  const titleNext = text(next.title);
  if (titleNext !== titlePrev) {
    out.push({ field: "title", from: titlePrev, to: titleNext });
  }
  const descPrev = text(prev.description);
  const descNext = text(next.description);
  if (descNext !== descPrev) {
    out.push({ field: "description", from: descPrev, to: descNext });
  }
  const typePrev = text(prev.type);
  const typeNext = text(next.type);
  if (typeNext && typeNext !== typePrev) {
    out.push({ field: "type", from: typePrev, to: typeNext });
  }
  const prioPrev = text((prev as { priority?: unknown }).priority);
  const prioNext = text((next as { priority?: unknown }).priority);
  if (prioNext !== prioPrev) {
    out.push({
      field: "priority",
      from: prioPrev || "—",
      to: prioNext || "—",
    });
  }
  const tagsPrev = tagSetKey(prev.tags);
  const tagsNext = tagSetKey(next.tags);
  if (tagsNext !== tagsPrev) {
    out.push({ field: "tags", from: tagsPrev, to: tagsNext });
  }
  const linksPrev = linkSetKey(prev.links);
  const linksNext = linkSetKey(next.links);
  if (linksNext !== linksPrev) {
    out.push({ field: "relations", from: linksPrev, to: linksNext });
  }
  const verPrev = verifyLabel(prev.verified);
  const verNext = verifyLabel(next.verified);
  if (verNext !== verPrev) {
    out.push({ field: "verify", from: verPrev, to: verNext });
  }
  const statusChanged =
    text((prev as { status?: unknown }).status) !==
    text((next as { status?: unknown }).status);
  const branchPrev = text((prev as { branchName?: unknown }).branchName);
  const branchNext = text((next as { branchName?: unknown }).branchName);
  if (branchNext !== branchPrev && !statusChanged) {
    out.push({ field: "branch", from: branchPrev, to: branchNext });
  }
  return out;
}
