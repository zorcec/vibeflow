/**
 * `fetchNotifications` — the ONE read behind `vibeflow notifications` and the
 * `get_notifications` tool (ticket ae96cee7, parent 4e4feca1).
 *
 * Local reads go through the store C1 writes (`.vibeflow/notifications.jsonl`),
 * so these tests seed a real temp project instead of stubbing the reader. The
 * online half injects its own transport and asserts the request it built: the
 * v0 path, the Bearer header and the board scope. The rule that matters on the
 * online path is FAIL CLOSED — a 401/500 is an error, never a silent local read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Project auth is the ONE seam that decides "linked to a board": the online
// half of these tests needs a token, the local half must not have one.
vi.mock("../../src/auth/project-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/auth/project-auth.js")>();
  return { ...actual, resolveProjectAuth: vi.fn() };
});

import { resolveProjectAuth } from "../../src/auth/project-auth.js";
import { saasAuth, localAuth } from "./helpers/mock-project-auth.js";
import {
  fetchNotifications,
  INVALID_SINCE_MESSAGE,
  NOTIFICATIONS_V0_PATH,
  type FetchTransport,
} from "../../src/core/notifications-fetch.js";
import type { NotificationEvent } from "../../src/core/notifications.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "vf-notif-fetch-"));
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
  vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth(projectDir));
  delete process.env.VIBEFLOW_API_URL;
});

afterEach(() => {
  vi.mocked(resolveProjectAuth).mockReset();
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
  delete process.env.VIBEFLOW_API_URL;
});

/** Pin every volatile field so assertions can be exact. */
function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    ts: "2026-11-22T10:00:00.000Z",
    type: "task.create",
    taskId: "task-1",
    actor: "agent",
    ...overrides,
  };
}

/** Write events exactly as the CLI does: one JSON line per event. */
function seedLog(events: NotificationEvent[]): void {
  writeFileSync(
    join(projectDir, ".vibeflow", "notifications.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  );
}

/** A transport that records the request and answers a canned response. */
function stubTransport(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchTransport = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    } as Response;
  };
  return { fetchImpl, calls };
}

describe("fetchNotifications — local backend", () => {
  it("reads the store the CLI writes, in file order, with the cursor", async () => {
    seedLog([
      event({ id: "evt_1", ts: "2026-11-22T10:00:00.000Z" }),
      event({
        id: "evt_2",
        ts: "2026-11-22T10:00:01.000Z",
        type: "task.update",
        changed: ["status"],
      }),
    ]);
    const result = await fetchNotifications(projectDir, { target: "local" });
    expect(result).toEqual({
      ok: true,
      target: "local",
      notifications: [
        {
          id: "evt_1",
          ts: "2026-11-22T10:00:00.000Z",
          type: "task.create",
          taskId: "task-1",
          actor: "agent",
        },
        {
          id: "evt_2",
          ts: "2026-11-22T10:00:01.000Z",
          type: "task.update",
          taskId: "task-1",
          actor: "agent",
          changed: ["status"],
        },
      ],
      nextTs: "2026-11-22T10:00:01.000Z",
      earliestTs: "2026-11-22T10:00:00.000Z",
      gap: false,
      truncated: false,
      count: 2,
    });
  });

  it("passes `since` (inclusive) and `limit` (newest win) straight through", async () => {
    seedLog([
      event({ id: "evt_1", ts: "2026-11-22T10:00:00.000Z" }),
      event({ id: "evt_2", ts: "2026-11-22T10:00:01.000Z" }),
      event({ id: "evt_3", ts: "2026-11-22T10:00:02.000Z" }),
    ]);
    const limited = await fetchNotifications(projectDir, {
      target: "local",
      since: "2026-11-22T10:00:01.000Z",
      limit: 1,
    });
    expect(limited.ok).toBe(true);
    if (!limited.ok) return;
    // since is INCLUSIVE (the boundary event repeats), limit keeps the NEWEST.
    expect(limited.notifications.map((e) => (e as NotificationEvent).id)).toEqual([
      "evt_3",
    ]);
    expect(limited.truncated).toBe(true);
    expect(limited.nextTs).toBe("2026-11-22T10:00:02.000Z");
  });

  it("propagates `gap` when `since` predates what is still stored", async () => {
    seedLog([event({ id: "evt_1", ts: "2026-11-22T10:00:00.000Z" })]);
    const result = await fetchNotifications(projectDir, {
      target: "local",
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.gap).toBe(true);
    expect(result.earliestTs).toBe("2026-11-22T10:00:00.000Z");
  });

  it("an absent log is an empty feed, not a failure", async () => {
    const result = await fetchNotifications(projectDir, { target: "local" });
    expect(result).toEqual({
      ok: true,
      target: "local",
      notifications: [],
      nextTs: null,
      earliestTs: null,
      gap: false,
      truncated: false,
      count: 0,
    });
  });

  it("resolves to local when the project has no board credential", async () => {
    // No explicit target: the project's own auth decides.
    const result = await fetchNotifications(projectDir, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toBe("local");
  });
});

describe("fetchNotifications — online backend", () => {
  beforeEach(() => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
  });

  it("calls GET {apiUrl}/api/v0/notifications with the PAT and the board scope", async () => {
    const { fetchImpl, calls } = stubTransport({
      notifications: [event()],
      nextTs: "2026-11-22T10:00:00.000Z",
      earliestTs: "2026-11-22T10:00:00.000Z",
      gap: false,
      truncated: false,
      count: 1,
    });
    const result = await fetchNotifications(projectDir, {
      target: "online",
      since: "2026-11-22T09:00:00.000Z",
      limit: 5,
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(NOTIFICATIONS_V0_PATH);
    expect(url.searchParams.get("since")).toBe("2026-11-22T09:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("5");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${saasAuth().token}`);
    // ADR-0005 board scoping: the same header every other v0 request carries.
    expect(headers["X-Vibeflow-Scope"]).toBe(saasAuth().workspaceId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toBe("online");
    expect(result.count).toBe(1);
  });

  it("maps the board payload onto the one result shape", async () => {
    const { fetchImpl } = stubTransport({
      notifications: [],
      nextTs: "2026-11-22T11:00:00.000Z",
      earliestTs: null,
      gap: true,
      truncated: true,
      count: 0,
    });
    const result = await fetchNotifications(projectDir, {
      target: "online",
      fetchImpl,
    });
    expect(result).toEqual({
      ok: true,
      target: "online",
      notifications: [],
      nextTs: "2026-11-22T11:00:00.000Z",
      earliestTs: null,
      gap: true,
      truncated: true,
      count: 0,
    });
  });

  it("401 and 500 are NOTIFICATIONS_FETCH_FAILED with the status", async () => {
    for (const status of [401, 500]) {
      const { fetchImpl } = stubTransport({}, status);
      const result = await fetchNotifications(projectDir, {
        target: "online",
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("NOTIFICATIONS_FETCH_FAILED");
      expect(result.message).toContain(String(status));
    }
  });

  it("never falls back to the local feed when the board refuses", async () => {
    // A local log exists AND the board 500s: the caller asked for the board,
    // so the answer is the refusal — never these events.
    seedLog([event({ id: "evt_local" })]);
    const { fetchImpl } = stubTransport({}, 500);
    const result = await fetchNotifications(projectDir, {
      target: "online",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOTIFICATIONS_FETCH_FAILED");
  });

  it("a 200 without a notification list is a refusal, not an empty feed", async () => {
    const { fetchImpl } = stubTransport({ ok: true });
    const result = await fetchNotifications(projectDir, {
      target: "online",
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOTIFICATIONS_FETCH_FAILED");
  });

  it("an explicit online read on an unlinked project fails closed", async () => {
    vi.mocked(resolveProjectAuth).mockResolvedValue(localAuth(projectDir));
    const result = await fetchNotifications(projectDir, { target: "online" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NOT_AUTHENTICATED");
  });
});

describe("fetchNotifications — `since` validation", () => {
  it("refuses an unparseable `since` before either backend runs", async () => {
    const { fetchImpl, calls } = stubTransport({ notifications: [] });
    const result = await fetchNotifications(projectDir, {
      target: "online",
      since: "not-a-date",
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      code: "INVALID_SINCE",
      message: INVALID_SINCE_MESSAGE,
    });
    // Nothing was sent upstream with a garbage cursor.
    expect(calls).toHaveLength(0);
  });

  it("refuses it on the local backend too", async () => {
    const result = await fetchNotifications(projectDir, {
      target: "local",
      since: "not-a-date",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_SINCE");
  });
});
