/**
 * Local subscriber registry — the "Watching" badge's source of truth on the
 * local board (ticket cgor65lmpv31cib1ef9zce5m).
 *
 * Pure unit tests with an injected clock: TTL boundary, heartbeat liveness,
 * idempotent re-registration, per-user/per-agent aggregation and board
 * isolation. The hosted twin is pinned in
 * `vibeflow-private/packages/web/tests/unit/notifications-subscribers.test.ts`;
 * the two modules are deliberate 1:1 copies, so the cases match.
 *
 * TTL is a visible contract (`SUBSCRIBER_TTL_MS`): an entry exactly at the
 * boundary is GONE, so a follower must heartbeat before it.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SUBSCRIBER_HEARTBEAT_MS,
  SUBSCRIBER_TTL_MS,
  TASK_CLAIM_TTL_MS,
  __resetSubscribersForTests,
  listSubscribers,
  listTaskClaims,
  registerSubscriber,
  removeSubscriber,
} from "../../../src/core/subscribers.js";

const BOARD = "/tmp/watch-project-a";
const OTHER_BOARD = "/tmp/watch-project-b";
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);

function sub(id: string, agent = "agent", user = "local") {
  return { subscriberId: id, agent, user };
}

describe("local notification subscriber registry", () => {
  beforeEach(() => {
    __resetSubscribersForTests();
  });

  it("starts empty and groups live followers by user and agent", () => {
    expect(listSubscribers(BOARD, T0)).toEqual({
      total: 0,
      byUser: [],
      byAgent: [],
      subscribers: [],
    });

    registerSubscriber(BOARD, sub("sub_a"), T0);
    registerSubscriber(BOARD, sub("sub_b", "claude"), T0 + 1);

    expect(listSubscribers(BOARD, T0 + 1)).toEqual({
      total: 2,
      byUser: [{ user: "local", agents: 2 }],
      byAgent: [
        { agent: "agent", count: 1 },
        { agent: "claude", count: 1 },
      ],
      subscribers: [
        {
          subscriberId: "sub_b",
          user: "local",
          agent: "claude",
          registeredAt: T0 + 1,
          lastSeenAt: T0 + 1,
        },
        {
          subscriberId: "sub_a",
          user: "local",
          agent: "agent",
          registeredAt: T0,
          lastSeenAt: T0,
        },
      ],
    });
  });

  it("stores the delivered activity and overwrites it on the next heartbeat", () => {
    registerSubscriber(
      BOARD,
      {
        ...sub("sub_a"),
        activity: { type: "task.claim", taskId: "task_a", at: T0 + 5 },
      },
      T0,
    );
    expect(listSubscribers(BOARD, T0).subscribers[0]?.activity).toEqual({
      type: "task.claim",
      taskId: "task_a",
      at: T0 + 5,
    });

    registerSubscriber(
      BOARD,
      {
        ...sub("sub_a"),
        activity: { type: "task.comment", taskId: "task_b", at: T0 + 30 },
      },
      T0 + SUBSCRIBER_HEARTBEAT_MS,
    );
    // The latest delivery replaced the previous one — nothing accumulates.
    expect(
      listSubscribers(BOARD, T0 + SUBSCRIBER_HEARTBEAT_MS).subscribers[0]
        ?.activity,
    ).toEqual({ type: "task.comment", taskId: "task_b", at: T0 + 30 });

    // A heartbeat without activity clears it: the entry always shows what the
    // LAST heartbeat knew, never a stale delivery.
    registerSubscriber(BOARD, sub("sub_a"), T0 + SUBSCRIBER_HEARTBEAT_MS * 2);
    expect(
      listSubscribers(
        BOARD,
        T0 + SUBSCRIBER_HEARTBEAT_MS * 2,
      ).subscribers[0]?.activity,
    ).toBeUndefined();
  });

  it("lists the most recent delivery first and drops expired rows", () => {
    registerSubscriber(
      BOARD,
      { ...sub("sub_a"), activity: { type: "task.claim", at: T0 + 70 } },
      T0,
    );
    registerSubscriber(BOARD, sub("sub_b", "claude"), T0 + 80);

    // Activity outranks a newer heartbeat; the follower with none goes last.
    expect(
      listSubscribers(BOARD, T0 + 80).subscribers.map((s) => s.subscriberId),
    ).toEqual(["sub_a", "sub_b"]);

    // TTL still evicts, and the row leaves the list with the aggregate.
    const expired = listSubscribers(BOARD, T0 + 80 + SUBSCRIBER_TTL_MS);
    expect(expired.total).toBe(0);
    expect(expired.subscribers).toEqual([]);
  });

  it("re-registering the same id is idempotent and refreshes liveness", () => {
    registerSubscriber(BOARD, sub("sub_a"), T0);
    registerSubscriber(BOARD, sub("sub_a"), T0 + SUBSCRIBER_HEARTBEAT_MS);

    expect(listSubscribers(BOARD, T0 + SUBSCRIBER_HEARTBEAT_MS).total).toBe(1);
    expect(listSubscribers(BOARD, T0 + SUBSCRIBER_TTL_MS).total).toBe(1);
    expect(
      listSubscribers(BOARD, T0 + SUBSCRIBER_HEARTBEAT_MS + SUBSCRIBER_TTL_MS)
        .total,
    ).toBe(0);
  });

  it("expires an entry exactly at the TTL", () => {
    registerSubscriber(BOARD, sub("sub_a"), T0);

    expect(listSubscribers(BOARD, T0 + SUBSCRIBER_TTL_MS - 1).total).toBe(1);
    expect(listSubscribers(BOARD, T0 + SUBSCRIBER_TTL_MS).total).toBe(0);
  });

  it("re-registering after expiry counts as one fresh follower", () => {
    registerSubscriber(BOARD, sub("sub_a"), T0);
    expect(listSubscribers(BOARD, T0 + SUBSCRIBER_TTL_MS).total).toBe(0);

    registerSubscriber(BOARD, sub("sub_a"), T0 + SUBSCRIBER_TTL_MS + 1);
    expect(listSubscribers(BOARD, T0 + SUBSCRIBER_TTL_MS + 1).total).toBe(1);
  });

  it("removes a follower idempotently and never touches another board", () => {
    registerSubscriber(BOARD, sub("sub_a"), T0);
    registerSubscriber(OTHER_BOARD, sub("sub_b", "claude"), T0);

    expect(removeSubscriber(BOARD, "sub_a", T0 + 1)).toBe(true);
    expect(removeSubscriber(BOARD, "sub_a", T0 + 1)).toBe(false);
    expect(listSubscribers(BOARD, T0 + 1).total).toBe(0);
    expect(listSubscribers(OTHER_BOARD, T0 + 1)).toEqual({
      total: 1,
      byUser: [{ user: "local", agents: 1 }],
      byAgent: [{ agent: "claude", count: 1 }],
      subscribers: [
        {
          subscriberId: "sub_b",
          user: "local",
          agent: "claude",
          registeredAt: T0,
          lastSeenAt: T0,
        },
      ],
    });
  });

  it("never resurrects an expired id through a heartbeat read", () => {
    registerSubscriber(BOARD, sub("sub_a"), T0);
    expect(removeSubscriber(BOARD, "sub_a", T0 + SUBSCRIBER_TTL_MS)).toBe(
      false,
    );
    expect(listSubscribers(BOARD, T0 + SUBSCRIBER_TTL_MS).total).toBe(0);
  });
});

/**
 * The "working on" claim (ticket qxvptxkta). The rule the whole feature lives
 * or dies by: a claim must never outlive the process that made it, and a claim
 * nobody is renewing must not survive as a frozen line either. Two clocks, both
 * proven here — the claim TTL (work stopped) and the subscriber TTL (process
 * died).
 */
describe("the 'working on' claim", () => {
  beforeEach(() => {
    __resetSubscribersForTests();
  });

  function claim(taskId: string, at: number, agent = "pi-77") {
    return { taskId, agent, at };
  }

  it("a dead agent's claim disappears at the claim TTL", () => {
    // The follower is alive (a heartbeat at T0) and claims task-a at T0.
    registerSubscriber(BOARD, { ...sub("sub_a", "pi-77"), current: claim("task-a", T0) }, T0);
    // Still credible one millisecond before the TTL…
    expect(listTaskClaims(BOARD, T0 + TASK_CLAIM_TTL_MS - 1)).toEqual([
      claim("task-a", T0),
    ]);
    // …and GONE at it. No age, no "last seen": the answer is silence, so a
    // reader that only renders what it is sent renders `idle, watching`.
    expect(listTaskClaims(BOARD, T0 + TASK_CLAIM_TTL_MS)).toEqual([]);
  });

  it("a live agent renews the claim by delivering again", () => {
    registerSubscriber(BOARD, { ...sub("sub_a", "pi-77"), current: claim("task-a", T0) }, T0);
    // One heartbeat later the follower delivered new work on the same task:
    // the claim's `at` moves, which is the ONLY renewal (the heartbeat itself
    // re-sends it but does not refresh the clock).
    const renewedAt = T0 + SUBSCRIBER_HEARTBEAT_MS;
    registerSubscriber(
      BOARD,
      { ...sub("sub_a", "pi-77"), current: claim("task-a", renewedAt) },
      renewedAt,
    );
    // Past the FIRST claim's TTL, still live because it was renewed.
    const later = T0 + TASK_CLAIM_TTL_MS + 10_000;
    expect(listTaskClaims(BOARD, later)).toEqual([claim("task-a", renewedAt)]);
  });

  it("fades a STILL-LIVE follower's stale claim: a heartbeat is not work", () => {
    registerSubscriber(BOARD, { ...sub("sub_a", "pi-77"), current: claim("task-a", T0) }, T0);
    // The process is unmistakably alive — it heartbeated well after the claim.
    const beat = T0 + 2 * TASK_CLAIM_TTL_MS;
    registerSubscriber(
      BOARD,
      { ...sub("sub_a", "pi-77"), current: claim("task-a", T0) },
      beat,
    );
    expect(listSubscribers(BOARD, beat).total).toBe(1);
    // …but it delivered no work on the task since T0, so it is not working on
    // it: the reader gets silence and renders `idle, watching`.
    expect(listTaskClaims(BOARD, beat)).toEqual([]);
  });

  it("reaps the claim with the process, even before the claim TTL is re-checked", () => {
    registerSubscriber(BOARD, { ...sub("sub_a", "pi-77"), current: claim("task-a", T0) }, T0);
    // No heartbeat since T0: the registry purges the whole entry, claim
    // included. This is the property a persisted claim could not have.
    expect(listTaskClaims(BOARD, T0 + SUBSCRIBER_TTL_MS)).toEqual([]);
    expect(listSubscribers(BOARD, T0 + SUBSCRIBER_TTL_MS).total).toBe(0);
  });

  it("clears the claim the moment a heartbeat stops carrying it", () => {
    registerSubscriber(BOARD, { ...sub("sub_a", "pi-77"), current: claim("task-a", T0) }, T0);
    // The agent finished the task: the next heartbeat omits `current`.
    registerSubscriber(BOARD, sub("sub_a", "pi-77"), T0 + SUBSCRIBER_HEARTBEAT_MS);
    expect(listTaskClaims(BOARD, T0 + SUBSCRIBER_HEARTBEAT_MS)).toEqual([]);
  });

  it("narrows to one task and reports the NEWEST claim when two followers overlap", () => {
    registerSubscriber(BOARD, { ...sub("sub_a", "pi-77"), current: claim("task-a", T0) }, T0);
    registerSubscriber(
      BOARD,
      { ...sub("sub_b", "pi-88"), current: claim("task-b", T0 + 5_000, "pi-88") },
      T0 + 5_000,
    );
    registerSubscriber(
      BOARD,
      { ...sub("sub_c", "pi-99"), current: claim("task-a", T0 + 9_000, "pi-99") },
      T0 + 9_000,
    );
    expect(listTaskClaims(BOARD, T0 + 10_000, "task-a")).toEqual([
      claim("task-a", T0 + 9_000, "pi-99"),
    ]);
    expect(listTaskClaims(BOARD, T0 + 10_000).map((c) => c.taskId)).toEqual([
      "task-a",
      "task-b",
    ]);
  });

  it("carries the claim on the watcher snapshot the board already serves", () => {
    registerSubscriber(BOARD, { ...sub("sub_a", "pi-77"), current: claim("task-a", T0) }, T0);
    expect(listSubscribers(BOARD, T0).subscribers[0]).toMatchObject({
      subscriberId: "sub_a",
      current: claim("task-a", T0),
    });
  });
});
