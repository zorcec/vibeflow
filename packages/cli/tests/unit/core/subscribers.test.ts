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
  __resetSubscribersForTests,
  listSubscribers,
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
    });
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
