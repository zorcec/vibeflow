/**
 * Long-poll for the local feed (ticket olkwa34zghp22owchuhzaaba).
 *
 * `GET /api/notifications?since=<iso>&wait=<ms>` holds the request open until
 * an event is appended to `<project>/.vibeflow/notifications.jsonl` or the
 * bound expires — one held request per follower instead of a 2 s poll, which
 * on a busy board was the dominant cost.
 *
 * Why a FILE WATCH and not the board's in-process broadcast: the writers are
 * CLI processes, not the board. A `vibeflow tasks --edit` in another shell
 * appends to the same log, so an in-process hook would wake nobody and the
 * follower would learn about a peer's write only when the bound expired —
 * strictly WORSE than the 2 s poll it replaces. The append IS the signal, and
 * the log file is where every writer, in every process, leaves one.
 *
 * The two rules that make a held read safe:
 * - a wait that expires answers an EMPTY page with `nextTs` UNCHANGED and
 *   `gap: false`: nothing was lost, so it must not look like a loss (the
 *   follower would otherwise either advance its cursor past unseen events or
 *   scream about a gap every 20 s);
 * - a wait is only ever held when the caller ALREADY has everything stored
 *   (see {@link readNotificationsWithWait}) — it can never delay an event the
 *   caller has not seen.
 */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  NOTIFICATIONS_WAIT_MAX_MS,
  readNotifications,
  type NotificationFilter,
  type NotificationReadResult,
  type NotificationWaitSignal,
} from "./notifications.js";
import { PROTO_DIR } from "./types.js";

/** One held read: the answer, plus the signal that says how it ended. */
export interface NotificationsWaitResult {
  read: NotificationReadResult;
  /** Present iff the caller asked for a wait — the explicit capability signal. */
  wait: NotificationWaitSignal | null;
}

/** What a caller may send on a held read; `waitMs` absent = the plain poll. */
export interface NotificationsWaitOptions {
  since?: string;
  limit?: number;
  filter?: NotificationFilter;
  /**
   * Bound to apply, in ms. Absent (undefined) = answer immediately and send no
   * `wait` field at all — that is a poll, not a wait.
   */
  waitMs?: number;
}

/** One project's watcher plus the resolvers waiting on it. */
interface AppendWatch {
  watcher: FSWatcher;
  listeners: Set<() => void>;
}

const watches = new Map<string, AppendWatch>();

/** Drop one project's watcher — on error, and when the last waiter leaves. */
function closeWatch(projectDir: string): void {
  const entry = watches.get(projectDir);
  if (entry === undefined) return;
  watches.delete(projectDir);
  entry.listeners.clear();
  try {
    entry.watcher.close();
  } catch {
    /* already gone — nothing to release */
  }
}

function notifyAppend(projectDir: string): void {
  const entry = watches.get(projectDir);
  if (entry === undefined) return;
  // Copy first: a listener removes itself while being called.
  for (const listener of [...entry.listeners]) listener();
}

/**
 * Watch `<project>/.vibeflow` (the DIRECTORY, not the file): the store trims
 * itself with tmp-file + rename once past {@link NOTIFICATIONS_MAX_EVENTS},
 * and a watch on the replaced inode would stop firing. Not `persistent`: a
 * follower's own watcher must never be the reason its process cannot exit.
 *
 * Never throws. A project with no `.vibeflow` yet, or a platform that refuses
 * the watch, simply has no signal — the caller's bound still answers, so the
 * feed degrades to a slow poll rather than to silence.
 *
 * Returns the detach function, or `null` when no watcher could be armed.
 */
function watchAppends(
  projectDir: string,
  listener: () => void,
): (() => void) | null {
  let entry = watches.get(projectDir);
  if (entry === undefined) {
    const dir = join(projectDir, PROTO_DIR);
    if (!existsSync(dir)) return null;
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename.toString().startsWith("notifications.")) {
          notifyAppend(projectDir);
        }
      });
    } catch {
      return null;
    }
    watcher.on("error", () => closeWatch(projectDir));
    entry = { watcher, listeners: new Set() };
    watches.set(projectDir, entry);
  }
  const watchEntry = entry;
  watchEntry.listeners.add(listener);
  return () => {
    watchEntry.listeners.delete(listener);
    if (watchEntry.listeners.size === 0) closeWatch(projectDir);
  };
}

/**
 * The hold itself: resolves `"event"` on the next append, `"timeout"` when the
 * bound expires first. `close()` releases the watcher and the timer without
 * resolving — for a caller that decided not to wait after all.
 *
 * `fired` is a promise, not a callback, because the caller awaits it and its
 * cleanup must be unconditional.
 */
export interface AppendHold {
  fired: Promise<"event" | "timeout">;
  close: () => void;
}

/** Bounded holds for tests: 0 or less means "do not hold at all". */
export function beginAppendHold(projectDir: string, boundMs: number): AppendHold {
  let finish: (released: "event" | "timeout") => void = () => {};
  const fired = new Promise<"event" | "timeout">((resolve) => {
    finish = resolve;
  });
  let done = false;
  let detach: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Release the watcher and the timer without resolving — a caller that decided not to wait. */
  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    detach?.();
    detach = null;
  };
  const release = (released: "event" | "timeout"): void => {
    if (done) return;
    done = true;
    stop();
    finish(released);
  };
  // Attach BEFORE the caller reads, so an append that lands between the read
  // and the hold can never be missed (it would otherwise sleep out the bound
  // while its event sat on disk).
  detach = watchAppends(projectDir, () => release("event"));
  timer = setTimeout(() => release("timeout"), Math.max(0, boundMs));
  // A held read must never be the reason a follower cannot exit: `stop()` ends
  // the process on a signal, so the timer only needs to outlive the request.
  timer.unref?.();
  return { fired, close: stop };
}

/**
 * The answer a wait that expired returns: the pre-wait read with its page
 * emptied and `gap` forced FALSE.
 *
 * Both halves are the point. An empty page keeps the follower from re-emitting
 * the boundary event it already has; `nextTs` unchanged means the cursor does
 * not move over anything unseen; `gap: false` says "this wait was not a loss".
 * The pre-wait read cannot carry a gap anyway (a gap answers immediately), so
 * the `false` here is a restatement, not a correction — which is exactly why
 * it is written down.
 */
function timedOutPage(before: NotificationReadResult): NotificationReadResult {
  return {
    ...before,
    notifications: [],
    truncated: false,
    count: 0,
    gap: false,
  };
}

/** Applied bound: clamped to the ceiling; a non-positive ask holds nothing. */
export function resolveWaitBound(waitMs: number): number {
  if (!Number.isFinite(waitMs) || waitMs <= 0) return 0;
  return Math.min(Math.floor(waitMs), NOTIFICATIONS_WAIT_MAX_MS);
}

/**
 * Read the feed, holding the request open for up to `waitMs` when the caller
 * is already up to date.
 *
 * Held only when ALL of these hold: a bound was asked for, a `since` cursor
 * was given, nothing in the page is newer than that cursor, and there is no
 * gap to report. Otherwise the plain read is the right answer and it is
 * returned at once with `released: "ready"` — the follower then re-reads
 * immediately, which is exactly what a fresh cursor wants.
 */
export async function readNotificationsWithWait(
  projectDir: string,
  opts: NotificationsWaitOptions,
): Promise<NotificationsWaitResult> {
  if (opts.waitMs === undefined) {
    return { read: readNotifications(projectDir, opts), wait: null };
  }
  const boundMs = resolveWaitBound(opts.waitMs);
  if (boundMs === 0) {
    return {
      read: readNotifications(projectDir, opts),
      wait: { boundMs, released: "ready" },
    };
  }
  const hold = beginAppendHold(projectDir, boundMs);
  const before = readNotifications(projectDir, opts);
  const sinceMs = opts.since === undefined ? null : Date.parse(opts.since);
  const hasNewer =
    sinceMs !== null &&
    !Number.isNaN(sinceMs) &&
    before.notifications.some((event) => Date.parse(event.ts) > sinceMs);
  if (sinceMs === null || hasNewer || before.gap) {
    hold.close();
    return { read: before, wait: { boundMs, released: "ready" } };
  }
  const released = await hold.fired;
  if (released === "timeout") {
    return {
      read: timedOutPage(before),
      wait: { boundMs, released: "timeout" },
    };
  }
  // Woken by an append: re-read so the answer is the page as it is NOW, not
  // the one from before the wait. A wake the filter drops returns an empty
  // page — honest, and the follower re-polls at once.
  return { read: readNotifications(projectDir, opts), wait: { boundMs, released } };
}

/** Test seam: drop every watcher this process holds. */
export function __resetNotificationWaitsForTests(): void {
  for (const projectDir of [...watches.keys()]) closeWatch(projectDir);
}
