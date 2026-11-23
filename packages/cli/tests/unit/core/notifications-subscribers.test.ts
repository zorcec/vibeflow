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
  createSubscriberIdentity,
  registerNotificationSubscriber,
  unregisterNotificationSubscriber,
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
