/**
 * The held read behind `GET /api/notifications?wait=` (ticket
 * olkwa34zghp22owchuhzaaba).
 *
 * Three things are load-bearing and each is a test here:
 * - an append RELEASES a waiter (the whole point: no 2 s poll);
 * - the bound EXPIRES the wait (a quiet board must not pin a request forever);
 * - a wait that expired is an EMPTY page with `nextTs` unchanged and
 *   `gap: false` — "nothing happened" must never be reported as "you lost
 *   something". The seed event sits exactly ON the cursor, so the un-held read
 *   would return it: the empty page is the contract biting, not an artefact of
 *   an empty store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendNotification,
  type NotificationEvent,
} from "../../src/core/notifications.js";
import {
  __resetNotificationWaitsForTests,
  readNotificationsWithWait,
} from "../../src/core/notifications-wait.js";

const CURSOR = "2026-11-27T10:00:00.000Z";
const LATER = "2026-11-27T10:00:05.000Z";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "vf-notif-wait-"));
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
});

afterEach(() => {
  __resetNotificationWaitsForTests();
  vi.useRealTimers();
  rmSync(projectDir, { recursive: true, force: true });
});

function event(id: string, ts = CURSOR): NotificationEvent {
  return { id, ts, type: "task.create", taskId: "task-1", actor: "agent" };
}

describe("readNotificationsWithWait", () => {
  it("releases a held read on the next append", async () => {
    // The boundary event sits ON the cursor: nothing NEWER is stored, so the
    // read must be held rather than answered.
    appendNotification(projectDir, event("evt_boundary"));
    const held = readNotificationsWithWait(projectDir, {
      since: CURSOR,
      waitMs: 5_000,
    });
    appendNotification(projectDir, event("evt_fresh", LATER));

    const answer = await held;
    expect(answer.wait).toEqual({ boundMs: 5_000, released: "event" });
    expect(answer.read.notifications.map((e) => e.id)).toEqual([
      "evt_boundary",
      "evt_fresh",
    ]);
  });

  it("times out after the bound with an empty page that is NOT a gap", async () => {
    vi.useFakeTimers();
    appendNotification(projectDir, event("evt_boundary"));
    const held = readNotificationsWithWait(projectDir, {
      since: CURSOR,
      waitMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const answer = await held;

    expect(answer.wait).toEqual({ boundMs: 5_000, released: "timeout" });
    // Empty, and the boundary event is NOT re-delivered...
    expect(answer.read.notifications).toEqual([]);
    expect(answer.read.count).toBe(0);
    expect(answer.read.truncated).toBe(false);
    // ...the cursor did not move over anything unseen...
    expect(answer.read.nextTs).toBe(CURSOR);
    // ...and an expired wait is not lost data.
    expect(answer.read.gap).toBe(false);
  });

  it("answers at once when the page already holds something newer", async () => {
    appendNotification(projectDir, event("evt_boundary"));
    appendNotification(projectDir, event("evt_fresh", LATER));
    const answer = await readNotificationsWithWait(projectDir, {
      since: CURSOR,
      waitMs: 5_000,
    });
    expect(answer.wait).toEqual({ boundMs: 5_000, released: "ready" });
    expect(answer.read.notifications.map((e) => e.id)).toEqual([
      "evt_boundary",
      "evt_fresh",
    ]);
  });

  it("answers at once with no cursor: a first read has nothing to wait for", async () => {
    appendNotification(projectDir, event("evt_boundary"));
    const answer = await readNotificationsWithWait(projectDir, { waitMs: 5_000 });
    expect(answer.wait).toEqual({ boundMs: 5_000, released: "ready" });
    expect(answer.read.count).toBe(1);
  });

  it("reports a gap now instead of holding it for the bound", async () => {
    appendNotification(projectDir, event("evt_boundary"));
    const answer = await readNotificationsWithWait(projectDir, {
      since: "2026-11-27T09:00:00.000Z",
      waitMs: 5_000,
    });
    expect(answer.wait?.released).toBe("ready");
    expect(answer.read.gap).toBe(true);
    expect(answer.read.count).toBe(1);
  });

  it("sends no signal at all when no wait was asked for — the plain poll", async () => {
    appendNotification(projectDir, event("evt_boundary"));
    const answer = await readNotificationsWithWait(projectDir, { since: CURSOR });
    // `null`, not a fabricated `ready`: an absent signal is how a follower
    // tells "this board does not hold reads" from "this board had one ready".
    expect(answer.wait).toBeNull();
    expect(answer.read.count).toBe(1);
  });
});
