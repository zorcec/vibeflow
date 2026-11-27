/**
 * The delay-and-coalesce buffer in front of a follower's writes (ticket
 * cgvk6mir).
 *
 * Every test here is a rule from the design, not an example of it:
 * - a burst on ONE task becomes ONE line, and that line is the burst's last
 *   event (a real event, never a synthesised summary);
 * - a wake (comment/delete/claim) flushes its task's burst FIRST and is
 *   delivered at once — the delay must never sit on what woke the agent;
 * - the ceiling flushes a hot bucket, or a task that keeps changing is
 *   postponed forever by its own arrivals;
 * - a delete never coalesces at all;
 * - exit does not lose a bucket, and a flush whose target is gone does not
 *   throw;
 * - one task's bucket never blocks another's, and one flush pass never prints
 *   a later arrival before an earlier one.
 *
 * Time is VIRTUAL (`vi.useFakeTimers`): the two constants are wall-clock
 * durations, and a test that slept them would be slow and flaky at once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  NOTIFICATIONS_COALESCE_CEILING_MS,
  NOTIFICATIONS_COALESCE_WINDOW_MS,
  createNotificationCoalescer,
  mayCoalesce,
} from "../../../src/core/notifications-coalesce.js";

/** Two tasks to prove the buffer is keyed by task, not by process. */
const TASK_A = "cgvk6mirse0s5v6zp3igz1p3";
const TASK_B = "cwq5lh4eej297mbwuv8sqc11";

let seq = 0;

function event(
  type: string,
  taskId: string,
  changed: string[] = [],
): { id: string; ts: string; type: string; taskId: string; actor: string; changed: string[] } {
  seq += 1;
  return {
    id: `evt_${String(seq).padStart(26, "0")}`,
    ts: new Date(Date.UTC(2026, 10, 27, 10, 0, seq)).toISOString(),
    type,
    taskId,
    actor: "agent",
    changed,
  };
}

function collector(): {
  deliver: (event: unknown) => void;
  lines: Array<Record<string, unknown>>;
  ids: () => string[];
} {
  const lines: Array<Record<string, unknown>> = [];
  return {
    deliver: (e) => {
      lines.push(e as Record<string, unknown>);
    },
    lines,
    ids: () => lines.map((e) => String(e.id)),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mayCoalesce — the classifier seam", () => {
  it("coalesces a task.update and wakes on everything else", () => {
    expect(mayCoalesce(event("task.update", TASK_A))).toBe(true);
    for (const type of ["task.comment", "task.delete", "task.create", "task.claim", "verify"]) {
      expect(mayCoalesce(event(type, TASK_A))).toBe(false);
    }
    // An unknown shape wakes: when in doubt, deliver.
    expect(mayCoalesce(undefined)).toBe(false);
    expect(mayCoalesce({})).toBe(false);
  });
});

describe("createNotificationCoalescer", () => {
  it("turns two updates on one task inside the window into ONE line", async () => {
    const { deliver, lines, ids } = collector();
    const buffer = createNotificationCoalescer(deliver);

    const first = event("task.update", TASK_A, ["status"]);
    const second = event("task.update", TASK_A, ["title"]);
    buffer.push(first);
    await vi.advanceTimersByTimeAsync(500);
    buffer.push(second);

    // Nothing has been delivered yet: the burst is still open.
    expect(lines).toEqual([]);

    // The window restarts on the second arrival, so 1.6 s later it is STILL
    // open — the resting point is the newest arrival, not the first.
    await vi.advanceTimersByTimeAsync(1_600);
    expect(lines).toEqual([]);

    await vi.advanceTimersByTimeAsync(500);
    expect(lines).toHaveLength(1);
    // The delivered line is the burst's LAST event, untouched: a real event a
    // consumer can still fetch by id.
    expect(ids()).toEqual([second.id]);
    expect(lines[0]!.changed).toEqual(["title"]);
  });

  it("flushes the task's bucket before delivering a comment, in order", async () => {
    const { deliver, lines, ids } = collector();
    const buffer = createNotificationCoalescer(deliver);

    buffer.push(event("task.update", TASK_A, ["status"]));
    buffer.push(event("task.update", TASK_A, ["title"]));
    const comment = event("task.comment", TASK_A, ["comments"]);

    await vi.advanceTimersByTimeAsync(1_000);
    buffer.push(comment);

    // Both lines, at once, burst first — no waiting for the window.
    expect(lines).toHaveLength(2);
    expect(lines[0]!.type).toBe("task.update");
    expect(lines[1]!.id).toBe(comment.id);
    expect(ids()[1]).toBe(comment.id);

    // The bucket is gone: the window firing later must not repeat it.
    await vi.advanceTimersByTimeAsync(NOTIFICATIONS_COALESCE_WINDOW_MS * 2);
    expect(lines).toHaveLength(2);
  });

  it("flushes a hot bucket at the ceiling instead of postponing it forever", async () => {
    const { deliver, lines } = collector();
    const buffer = createNotificationCoalescer(deliver);

    // An update every second: the window restarts each time, so a reader that
    // waited for the burst to rest would wait forever.
    buffer.push(event("task.update", TASK_A, ["status"])); // t = 0, bucket opens
    await vi.advanceTimersByTimeAsync(1_000);
    buffer.push(event("task.update", TASK_A, ["status"])); // t = 1
    await vi.advanceTimersByTimeAsync(1_000);
    buffer.push(event("task.update", TASK_A, ["status"])); // t = 2
    await vi.advanceTimersByTimeAsync(1_000);
    buffer.push(event("task.update", TASK_A, ["status"])); // t = 3
    await vi.advanceTimersByTimeAsync(1_000);
    buffer.push(event("task.update", TASK_A, ["status"])); // t = 4
    expect(lines).toEqual([]); // 4 s of arrivals: the 2 s window never came to rest

    // t = 5 = the bucket's OPEN time + the ceiling: it surfaces anyway.
    await vi.advanceTimersByTimeAsync(
      NOTIFICATIONS_COALESCE_CEILING_MS - 4_000,
    );
    expect(lines).toHaveLength(1);
    // Still one line per task, and still a real event.
    expect(lines[0]!.taskId).toBe(TASK_A);
  });

  it("delivers a delete at once and never coalesces it", async () => {
    const { deliver, lines } = collector();
    const buffer = createNotificationCoalescer(deliver);

    const removed = event("task.delete", TASK_A);
    buffer.push(removed);
    expect(lines.map((e) => e.id)).toEqual([removed.id]);

    // A second delete is a second line: the buffer is not a home for wakes.
    const again = event("task.delete", TASK_A);
    buffer.push(again);
    expect(lines.map((e) => e.id)).toEqual([removed.id, again.id]);
  });

  it("does not lose a bucket on exit, and a dead target does not throw", async () => {
    const delivered: unknown[] = [];
    const buffer = createNotificationCoalescer((e) => {
      delivered.push(e);
      throw new Error("EPIPE: the reader is gone");
    });

    buffer.push(event("task.update", TASK_A, ["status"]));
    buffer.push(event("task.update", TASK_B, ["status"]));
    await vi.advanceTimersByTimeAsync(100);

    // The exit path: flush, and the throwing delivery must not escape it.
    expect(() => buffer.flushAll()).not.toThrow();
    expect(delivered).toHaveLength(2);
    // Flushed in the order the buckets OPENED (A then B), never reordered.
    expect((delivered[0] as { taskId: string }).taskId).toBe(TASK_A);
    expect((delivered[1] as { taskId: string }).taskId).toBe(TASK_B);

    // Idempotent: a second flush of an emptied buffer delivers nothing more.
    buffer.flushAll();
    expect(delivered).toHaveLength(2);
  });

  it("does not park a quiet task behind a hot one", async () => {
    const { deliver, lines } = collector();
    const buffer = createNotificationCoalescer(deliver);

    // A opens first (t = 0) and then keeps changing, so its window edge keeps
    // moving: its LAST arrival (t = 2) is what its flush is measured from.
    buffer.push(event("task.update", TASK_A, ["status"]));
    await vi.advanceTimersByTimeAsync(1_000);
    buffer.push(event("task.update", TASK_A, ["status"])); // A, t = 1

    buffer.push(event("task.update", TASK_B, ["status"])); // B opens, t = 1 → edge t = 3
    await vi.advanceTimersByTimeAsync(1_000);
    buffer.push(event("task.update", TASK_A, ["status"])); // A, t = 2 → edge t = 4

    // 1.5 s later B's own window has elapsed (it opened at t = 1, edge t = 3)
    // while A is still open: B must not be held behind A's burst.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(lines.map((e) => e.taskId)).toEqual([TASK_B]);

    // A surfaces on its own edge, not never.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines.map((e) => e.taskId)).toEqual([TASK_B, TASK_A]);
  });
});
