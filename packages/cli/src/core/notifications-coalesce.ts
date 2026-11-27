/**
 * Delay-and-coalesce a burst of `task.update` events (ticket cgvk6mir).
 *
 * A busy board writes one event per confirmed effect, so a single
 * `--edit --set-status X --title Y` is several `task.update` events a few
 * hundred milliseconds apart and a follower prints one line for each. The
 * buffer holds them for a short window and prints ONE line per task instead.
 *
 * Four rules, and each is a decision rather than a tuning knob:
 *
 * - **Key = `taskId`.** "The same thing" means the same TASK, not the same
 *   event id — the ids are unique by construction, so an id-keyed buffer would
 *   coalesce nothing at all.
 * - **Window 2 s, ceiling 5 s.** The window restarts on every arrival (a burst
 *   is a burst), and the ceiling is what stops a hot task from being postponed
 *   forever by its own arrivals: 5 s after the bucket OPENED it flushes
 *   whatever it holds.
 * - **Only `task.update` coalesces.** A `task.comment`, a `task.delete`, a
 *   claim — anything a reader might be waiting for — flushes its task's bucket
 *   and is delivered AT ONCE. The delay must never sit on the thing that woke
 *   the agent up.
 * - **Every delivered line is a real event.** A flush emits the bucket's LAST
 *   event as it was written — final `to`, final `changed`, an id that can be
 *   fetched — never a synthesised summary no store can answer for.
 *
 * Ordering: buckets are flushed in the order they OPENED (Map insertion
 * order), so one flush pass can never print a task that arrived later before
 * one that arrived earlier. Buckets never wait for each other, though: a quiet
 * task flushes on its own window even while another task's bucket is still
 * open, because a reader must not wait behind somebody else's burst.
 *
 * Delivery is a CALLBACK, not a write: this module knows nothing about stdout,
 * `--json` or an `--exec` child, and the follower keeps owning that. A
 * delivery that throws (the target is gone: EPIPE, a closed `--exec` pipe, a
 * process already unwinding) is swallowed — a flush is the last thing that
 * happens on exit, and it must never be the reason a follower dies with a
 * stack trace instead of unregistering.
 */

/** How long a bucket waits for the burst to finish, after the newest arrival. */
export const NOTIFICATIONS_COALESCE_WINDOW_MS = 2_000;

/** How long a bucket may stay open in total, however hot the task is. */
export const NOTIFICATIONS_COALESCE_CEILING_MS = 5_000;

/**
 * The classifier seam. Today the whole rule is "a `task.update` coalesces and
 * everything else wakes"; the real classifier (`wake | digest | drop`, still
 * on its own ticket) plugs in HERE, and only here — the buffer above never
 * looks at a type itself.
 */
export function mayCoalesce(event: unknown): boolean {
  return (event as { type?: unknown } | null | undefined)?.type === "task.update";
}

export interface NotificationCoalescer {
  /**
   * Offer one event. A coalescing event is buffered; anything else flushes its
   * own task's bucket first and is delivered immediately.
   */
  push(event: unknown): void;
  /**
   * Deliver everything still buffered, in the order the buckets opened. The
   * exit path calls this BEFORE the follower stops reading.
   */
  flushAll(): void;
}

interface Bucket {
  /** Every event of the burst, oldest first; the last one is what is delivered. */
  events: unknown[];
  /** When the bucket opened — the ceiling is measured from here. */
  first: number;
  /** Pending flush timer, replaced on every arrival (the window restarts). */
  timer: ReturnType<typeof setTimeout> | null;
}

function taskIdOf(event: unknown): string | undefined {
  const id: unknown = (event as { taskId?: unknown } | null | undefined)?.taskId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Build one follower's buffer. State is per-coalescer (per follower), never
 * module-level: two followers in one process must not share a bucket.
 */
export function createNotificationCoalescer(
  deliver: (event: unknown) => void,
): NotificationCoalescer {
  const buckets = new Map<string, Bucket>();

  /**
   * A flush whose target is gone must not throw (see the header): the process
   * may already be exiting and the pipe closed underneath us.
   */
  const deliverSafely = (event: unknown): void => {
    try {
      deliver(event);
    } catch {
      /* the target is gone — nothing left to deliver to */
    }
  };

  const flushBucket = (taskId: string): void => {
    const bucket = buckets.get(taskId);
    if (bucket === undefined) return;
    // Delete BEFORE delivering: a delivery that re-enters (a write that
    // appends a notification) must not find the same bucket still open.
    buckets.delete(taskId);
    if (bucket.timer !== null) clearTimeout(bucket.timer);
    bucket.timer = null;
    deliverSafely(bucket.events[bucket.events.length - 1]);
  };

  const schedule = (taskId: string, bucket: Bucket): void => {
    if (bucket.timer !== null) clearTimeout(bucket.timer);
    const now = Date.now();
    const edge = Math.min(
      now + NOTIFICATIONS_COALESCE_WINDOW_MS,
      bucket.first + NOTIFICATIONS_COALESCE_CEILING_MS,
    );
    bucket.timer = setTimeout(() => {
      bucket.timer = null;
      flushBucket(taskId);
    }, Math.max(0, edge - now));
  };

  return {
    push(event) {
      const taskId = taskIdOf(event);
      if (!mayCoalesce(event) || taskId === undefined) {
        // Wake-class: the burst this task already has goes out first, so the
        // reader sees what happened BEFORE the thing it is being woken for.
        if (taskId !== undefined) flushBucket(taskId);
        deliverSafely(event);
        return;
      }
      const open = buckets.get(taskId);
      if (open !== undefined) {
        open.events.push(event);
        schedule(taskId, open);
        return;
      }
      const bucket: Bucket = { events: [event], first: Date.now(), timer: null };
      buckets.set(taskId, bucket);
      schedule(taskId, bucket);
    },

    flushAll() {
      // Snapshot the keys: `flushBucket` deletes as it goes, and a delivery
      // could append to the buffer.
      for (const taskId of [...buckets.keys()]) flushBucket(taskId);
    },
  };
}
