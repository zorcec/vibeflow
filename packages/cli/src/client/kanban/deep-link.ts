/**
 * Path-based kanban deep links: `/kanban/<task-id>[/<tab>]`.
 *
 * - `/kanban/<task-id>` opens the task on the Details tab.
 * - `/kanban/<task-id>/activity` opens it on the Activity tab
 *   (the panel's internal `comments` tab).
 * - `/kanban/<task-id>/details` and `/kanban/<task-id>/files` open the
 *   Details and Files tabs explicitly; `/comments` is accepted as an
 *   alias of `/activity`.
 *
 * Pure functions only (no DOM) so they stay unit-testable in node.
 */
import type { PanelState } from "@vibeflow-tools/ui/kanban";

export type PanelTab = PanelState["tab"];

/** Canonical URL slug per panel tab. */
const TAB_TO_SLUG: Record<PanelTab, string> = {
  details: "details",
  comments: "activity",
  files: "files",
};

/** Accepted tab slugs (lowercase) — `comments` is an alias of `activity`. */
const SLUG_TO_TAB: Record<string, PanelTab> = {
  details: "details",
  activity: "comments",
  comments: "comments",
  files: "files",
};

export interface KanbanDeepLink {
  taskId: string;
  tab: PanelTab;
}

/**
 * Parse a path-based kanban deep link. Returns null for anything that is
 * not `/kanban/<30-char-hex-id>[/<tab>]` — the board then renders normally.
 * An unknown tab slug falls back to `details` (the task still opens).
 */
export function parseKanbanDeepLink(pathname: string): KanbanDeepLink | null {
  const segs = pathname.split("/").filter((s) => s.length > 0);
  if (segs.length !== 2 && segs.length !== 3) return null;
  if (segs[0] !== "kanban") return null;
  const taskId = segs[1];
  // Same shape the `#task-<id>` hash links require: full 30-char hex.
  if (!/^[a-f0-9]{30}$/i.test(taskId)) return null;
  const rawTab = (segs[2] ?? "").toLowerCase();
  const tab = rawTab ? (SLUG_TO_TAB[rawTab] ?? "details") : "details";
  return { taskId: taskId.toLowerCase(), tab };
}

/** Canonical shareable URL for an open panel state. */
export function taskPanelUrl(taskId: string, tab: PanelTab = "details"): string {
  return tab === "details"
    ? `/kanban/${taskId}`
    : `/kanban/${taskId}/${TAB_TO_SLUG[tab]}`;
}

/** History key identifying one open panel state (task + tab). */
export function panelHistoryKey(taskId: string, tab: PanelTab): string {
  return `${taskId.toLowerCase()}:${tab}`;
}
