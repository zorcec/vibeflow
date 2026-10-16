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
  /**
   * Tags only (ticket 59f91dc0): the actual tags added/removed, recorded
   * at diff time from the REAL tag arrays — comma-safe, unlike parsing
   * the comma-joined from/to keys (a tag may itself contain a comma:
   * TagInput takes the whole input as one tag). Absent on pre-fix
   * records; the renderer then derives the same diff from from/to.
   */
  added?: string[];
  removed?: string[];
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
  return normalizeTagList(tags).join(",");
}

/** Trimmed non-empty tags, sorted (the list form behind tagSetKey). */
export function normalizeTagList(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .sort();
}

/**
 * Set difference between two tag arrays (ticket 59f91dc0). Compares REAL
 * tag strings, so a tag containing a comma diffs exactly — the
 * comma-joined from/to keys cannot represent that unambiguously.
 */
export function diffTagLists(
  prevTags: unknown,
  nextTags: unknown,
): { added: string[]; removed: string[] } {
  const prev = new Set(normalizeTagList(prevTags));
  const next = new Set(normalizeTagList(nextTags));
  return {
    added: [...next].filter((t) => !prev.has(t)),
    removed: [...prev].filter((t) => !next.has(t)),
  };
}

/** Split a tagSetKey back into tags (inverse for comma-free tags only). */
export function parseTagKey(key: string): string[] {
  return key
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * The added/removed tags a change row should name (ticket 59f91dc0).
 * Prefers the arrays recorded at diff time (comma-safe); pre-fix records
 * carry only the comma-joined from/to keys, so those derive the same
 * diff by key parsing. Never invents names: both paths come from the
 * stored record.
 */
export function resolveTagChange(
  from: string,
  to: string,
  added?: string[],
  removed?: string[],
): { added: string[]; removed: string[] } {
  if (Array.isArray(added) && Array.isArray(removed)) {
    return { added, removed };
  }
  return diffTagLists(parseTagKey(from), parseTagKey(to));
}

/**
 * One-line tag diff, e.g. "added: bug, ui · removed: p1" (ticket 59f91dc0).
 * Added-only or removed-only changes name just their side.
 */
export function formatTagChange(
  added: readonly string[],
  removed: readonly string[],
): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added: ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`removed: ${removed.join(", ")}`);
  return parts.join(" · ");
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
    // 59f91dc0: record the actual diff at the source (comma-safe) — the
    // renderer names these arrays instead of a generic "changed tags".
    const { added, removed } = diffTagLists(prev.tags, next.tags);
    out.push({ field: "tags", from: tagsPrev, to: tagsNext, added, removed });
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
