/**
 * Activity-feed primitives (P17d.2) — the pure part of the collaboration
 * surface, moved out of the hosted app so the CLI board can render the same
 * feed without a second implementation.
 *
 * Nothing here fetches or touches a client: these are shape helpers and one
 * burst-collapsing reducer, which is what makes them safe in a public package.
 */
import type { Task } from "../kanban/types";

/** A board task carrying the server-stamped push actor (ticket tm6p4urj).
 *
 * `pushActor` is a column-only display annotation: the authenticated principal
 * that pushed/created the row, NULL on pre-column legacy rows. The shared
 * `Task` wire type lives here, so this stays an intersection — `Task` objects
 * without the annotation remain assignable and read as legacy rows.
 */
export type FeedTask = Task & {
  pushActor?: string | null;
  createOrigin?: string | null;
};

/** Minimal actor source `feedActorForTask` reads (structural). */
export interface FeedActorSource {
  pushActor?: string | null;
  authorName?: string;
  author?: string | null;
}

/**
 * Feed actor for one task's created/pushed history (ticket tm6p4urj).
 *
 * Precedence: recorded push actor first, then the stored record author — a
 * push of someone else's record renders the pusher without rewriting history.
 * Legacy rows fall back to the author so existing history never degrades to
 * "Unknown"; "Unknown" survives only when the row genuinely names nobody.
 */
export function feedActorForTask(t: FeedActorSource): string {
  return t.pushActor ?? t.authorName ?? t.author ?? "Unknown";
}

/** Canonical agent/API broadcast markers (ticket 98e0d08b, two-state rule). */
export function isAgentOrigin(origin: string | null | undefined): boolean {
  return origin === "cli" || origin === "mcp" || origin === "api";
}

export const PUSH_BURST_GAP_MS = 10 * 60 * 1000;

/** Minimal shape `collapseCreateBursts` reads (structural). */
export interface BurstCollapsibleEvent {
  id: string;
  time: string;
  user: string;
  action: string;
  detail: string;
  count?: number;
}

/**
 * Collapse bulk-push bursts (ticket f286acdc): a maximal run of `created`
 * events by ONE user with adjacent gaps <= `PUSH_BURST_GAP_MS` becomes a
 * single `{ action: "pushed", detail: "N tasks", count: N }` event (newest
 * time, first id). Runs of length 1 pass through as `created` — a pushed row
 * always means N >= 2, never a renamed single. Non-created actions, user
 * changes and over-window gaps all break the run. Input must be newest-first
 * (the feed's sort order); output preserves it.
 */
export function collapseCreateBursts<T extends BurstCollapsibleEvent>(events: T[]): T[] {
  const out: T[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]!);
    } else {
      const first = run[0]!;
      out.push({
        ...first,
        id: `pushed-${first.id}`,
        action: "pushed",
        detail: `${run.length} tasks`,
        count: run.length,
      });
    }
    run = [];
  };
  for (const ev of events) {
    const prev = run[run.length - 1];
    if (
      ev.action === "created" &&
      prev !== undefined &&
      prev.user === ev.user &&
      Math.abs(new Date(prev.time).getTime() - new Date(ev.time).getTime()) <= PUSH_BURST_GAP_MS
    ) {
      run.push(ev);
    } else {
      flush();
      if (ev.action === "created") {
        run = [ev];
      } else {
        out.push(ev);
      }
    }
  }
  flush();
  return out;
}
