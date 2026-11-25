/**
 * Subscriber side-calls for `vibeflow notifications --follow` (ticket
 * cgor65lmpv31cib1ef9zce5m): identity, URL/body of the register call, and the
 * idempotent unregister. The registry itself is pinned in subscribers.test.ts;
 * the HTTP routes in tests/e2e/notifications-subscribers.test.ts.
 *
 * Every call is BEST EFFORT — a board that is down must never stop the feed —
 * so the asserted contract is the `{ok}` result, not a thrown error.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig } from "../../../src/core/config.js";
import {
  NOTIFICATION_SUBSCRIBERS_LOCAL_PATH,
  activityFromEvent,
  createSubscriberIdentity,
  registerNotificationSubscriber,
  unregisterNotificationSubscriber,
  type NotificationSubscriberIdentity,
} from "../../../src/core/notifications-subscribers.js";
import type { FetchTransport } from "../../../src/core/notifications-fetch.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "vf-watch-unit-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function response(ok = true, status = 200): Response {
  return { ok, status, json: async () => ({}) } as Response;
}

describe("createSubscriberIdentity", () => {
  it("mints one sub_ id per process and uses the actor rule", () => {
    const first = createSubscriberIdentity({});
    const second = createSubscriberIdentity({});
    expect(first.subscriberId).toMatch(/^sub_[0-9a-f-]{36}$/);
    expect(first.subscriberId).not.toBe(second.subscriberId);
    expect(first.agent).toBe("agent");
    // A fresh follower has delivered nothing: no activity, not a fake one.
    expect(first.activity).toBeUndefined();
  });

  it("names the agent from VIBEFLOW_ACTOR, trimmed, with blank falling back", () => {
    expect(
      createSubscriberIdentity({ VIBEFLOW_ACTOR: "  claude  " }).agent,
    ).toBe("claude");
    expect(createSubscriberIdentity({ VIBEFLOW_ACTOR: "   " }).agent).toBe(
      "agent",
    );
  });
});

describe("activityFromEvent", () => {
  it("reports the delivered event's type and task with the DELIVERY time", () => {
    const at = 1_764_000_000_000;
    expect(
      activityFromEvent(
        {
          id: "evt_1",
          // An old event delivered now is activity NOW: the idle rule asks
          // whether the follower delivered lately, not how old the event is.
          ts: "2026-11-01T00:00:00.000Z",
          type: "task.claim",
          taskId: "ifhh7q2jukxhqcrs5kfo6mb8",
        },
        at,
      ),
    ).toEqual({ type: "task.claim", taskId: "ifhh7q2jukxhqcrs5kfo6mb8", at });
  });

  it("drops fields the event does not carry instead of inventing them", () => {
    expect(activityFromEvent({ type: "", taskId: 7 }, 42)).toEqual({ at: 42 });
    expect(activityFromEvent(null, 42)).toEqual({ at: 42 });
  });
});

describe("registerNotificationSubscriber (local)", () => {
  it("POSTs the identity to the config port and accepts any 2xx", async () => {
    writeConfig(projectDir, { port: 3811 });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchTransport = async (url, init) => {
      calls.push({ url, init });
      return response();
    };

    const result = await registerNotificationSubscriber(
      projectDir,
      "local",
      { subscriberId: "sub_unit_1", agent: "claude" },
      { fetchImpl },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `http://localhost:3811${NOTIFICATION_SUBSCRIBERS_LOCAL_PATH}`,
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      subscriberId: "sub_unit_1",
      agent: "claude",
    });
  });

  it("sends no activity for a follower that has delivered nothing", async () => {
    writeConfig(projectDir, { port: 3811 });
    const bodies: unknown[] = [];
    const result = await registerNotificationSubscriber(
      projectDir,
      "local",
      { subscriberId: "sub_unit_1", agent: "claude" },
      {
        fetchImpl: async (_url, init) => {
          bodies.push(JSON.parse(String(init.body)));
          return response();
        },
      },
    );
    expect(result).toEqual({ ok: true });
    // Absent, not null: the registry must read "no events yet".
    expect(bodies[0]).toEqual({ subscriberId: "sub_unit_1", agent: "claude" });
  });

  it("the heartbeat carries the LATEST activity, overwriting the previous one", async () => {
    writeConfig(projectDir, { port: 3811 });
    const bodies: Array<Record<string, unknown>> = [];
    const identity: NotificationSubscriberIdentity = {
      subscriberId: "sub_unit_1",
      agent: "claude",
    };
    const fetchImpl: FetchTransport = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return response();
    };

    identity.activity = { type: "task.claim", taskId: "task_a", at: 1_000 };
    await registerNotificationSubscriber(projectDir, "local", identity, {
      fetchImpl,
    });
    identity.activity = { type: "task.comment", taskId: "task_b", at: 2_000 };
    await registerNotificationSubscriber(projectDir, "local", identity, {
      fetchImpl,
    });

    expect(bodies).toEqual([
      {
        subscriberId: "sub_unit_1",
        agent: "claude",
        activity: { type: "task.claim", taskId: "task_a", at: 1_000 },
      },
      {
        subscriberId: "sub_unit_1",
        agent: "claude",
        activity: { type: "task.comment", taskId: "task_b", at: 2_000 },
      },
    ]);
  });

  it("reports a non-2xx as a best-effort failure, never a throw", async () => {
    writeConfig(projectDir, { port: 3811 });
    const result = await registerNotificationSubscriber(
      projectDir,
      "local",
      { subscriberId: "sub_unit_1", agent: "agent" },
      { fetchImpl: async () => response(false, 503) },
    );
    expect(result).toEqual({
      ok: false,
      message: "Subscriber registration failed: HTTP 503",
    });
  });

  it("reports a transport failure as a best-effort failure", async () => {
    writeConfig(projectDir, { port: 3811 });
    const result = await registerNotificationSubscriber(
      projectDir,
      "local",
      { subscriberId: "sub_unit_1", agent: "agent" },
      {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      message: "Subscriber registration failed: ECONNREFUSED",
    });
  });
});

describe("unregisterNotificationSubscriber (local)", () => {
  it("DELETEs the encoded subscriber id so a clean exit leaves no ghost", async () => {
    writeConfig(projectDir, { port: 3812 });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await unregisterNotificationSubscriber(
      projectDir,
      "local",
      "sub_unit/1",
      {
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return response();
        },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]!.url).toBe(
      `http://localhost:3812${NOTIFICATION_SUBSCRIBERS_LOCAL_PATH}/sub_unit%2F1`,
    );
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("refuses to claim success on a failed unregister", async () => {
    writeConfig(projectDir, { port: 3812 });
    const result = await unregisterNotificationSubscriber(
      projectDir,
      "local",
      "sub_unit_1",
      { fetchImpl: async () => response(false, 500) },
    );
    expect(result).toEqual({
      ok: false,
      message: "Subscriber unregister failed: HTTP 500",
    });
  });
});
