// @vitest-environment jsdom
/**
 * Per-task activity log (ticket ylgq1p5o). The feed read is narrowed with
 * `?taskId=` (ticket p3tkodry), and the log must stay honest in every state it
 * can be in: loading is not empty, a failed refresh keeps the saved rows AND
 * says how old the read is (never a silent, aged-out list), an older board
 * that widens the read never mixes two tasks' events, and a late answer for
 * the previously open task never paints the task now in front of the user
 * (the out-of-order pattern ticket d6hkvg4v added).
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  TaskActivityLog,
  agoLabel,
  eventDetail,
  eventVerb,
} from "../TaskActivityLog";

interface Deferred {
  promise: Promise<Response>;
  resolve: (body: unknown) => void;
  reject: (err: unknown) => void;
}

function deferredResponse(): Deferred {
  let resolve!: (body: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = (body: unknown) =>
      res({ ok: true, json: async () => body } as Response);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, json: async () => body } as Response);
}

function failed(status = 500): Promise<Response> {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({}),
  } as Response);
}

function event(
  id: string,
  overrides: Partial<{
    ts: string;
    type: string;
    taskId: string;
    actor: string;
    agent: string;
    changed: string[];
    to: Record<string, unknown>;
  }> = {},
) {
  return {
    id,
    ts: new Date(Date.now() - 30_000).toISOString(),
    type: "task.update",
    taskId: "task-a",
    actor: "agent",
    ...overrides,
  };
}

function feed(notifications: unknown[], gap = false) {
  return {
    notifications,
    nextTs: new Date().toISOString(),
    earliestTs: null,
    gap,
    truncated: false,
    count: notifications.length,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the log's wording", () => {
  it("renders known verbs, and the raw type rather than an invented one", () => {
    expect(eventVerb("task.update")).toBe("updated");
    expect(eventVerb("verify")).toBe("verified");
    expect(eventVerb("task.file")).toBe("changed files");
    expect(eventVerb("task.mystery")).toBe("task.mystery");
  });

  it("names the changed fields and a status target when the event carries them", () => {
    expect(
      eventDetail(
        event("e1", { changed: ["status", "priority"], to: { status: "review" } }),
      ),
    ).toBe("status, priority · → review");
    expect(eventDetail(event("e2"))).toBe("");
  });

  it("keeps the Watching badge's age wording", () => {
    expect(agoLabel(12_000)).toBe("12 s ago");
    expect(agoLabel(2 * 60_000)).toBe("2 min ago");
    expect(agoLabel(3 * 60 * 60_000)).toBe("3 h ago");
  });
});

describe("TaskActivityLog", () => {
  it("reads the feed narrowed to the task and renders each event with its age", async () => {
    const fetchMock = vi.fn(() =>
      ok(
        feed([
          event("e1", {
            type: "task.claim",
            actor: "pi",
            agent: "pi-77",
            ts: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
          }),
          event("e2", {
            changed: ["status"],
            to: { status: "review" },
            ts: new Date(Date.now() - 20_000).toISOString(),
          }),
        ]),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <TaskActivityLog endpoint="/api/notifications" taskId="task-a" pollIntervalMs={60_000} />,
    );
    // Loading is its own state — a slow read never reads as "no activity".
    expect(container.querySelector("#dp-log-loading")).not.toBeNull();
    expect(container.querySelector("#dp-log-empty")).toBeNull();

    await waitFor(() => expect(container.querySelector("#dp-log-rows")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(
      "/api/notifications?taskId=task-a&limit=20",
    );
    const rows = container.querySelectorAll("#dp-log-rows li");
    expect(rows).toHaveLength(2);
    // Newest first; the agent identity is the label when the event has one.
    expect(rows[0]?.textContent).toContain("agent");
    expect(rows[0]?.textContent).toContain("updated status · → review");
    expect(rows[0]?.textContent).toContain("20 s ago");
    expect(rows[1]?.textContent).toContain("pi-77");
    expect(rows[1]?.textContent).toContain("claimed");
    expect(rows[1]?.textContent).toContain("2 h ago");
    // The read itself is stamped, so a log that stops refreshing says so.
    expect(container.querySelector("#dp-log-read-age")?.textContent).toMatch(
      /^read \d+ s ago$/,
    );
  });

  it("says 'no activity yet' only after a successful empty read", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok(feed([]))));
    const { container } = render(
      <TaskActivityLog endpoint="/api/notifications" taskId="task-a" pollIntervalMs={60_000} />,
    );
    await waitFor(() => expect(container.querySelector("#dp-log-empty")).not.toBeNull());
    expect(container.querySelector("#dp-log-loading")).toBeNull();
    expect(container.textContent).toContain("No activity for this task yet.");
  });

  it("keeps the saved rows when a refresh fails, and shows how old the read is", async () => {
    const first = ok(feed([event("e1")]));
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockImplementation(() => failed());
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <TaskActivityLog endpoint="/api/notifications" taskId="task-a" pollIntervalMs={15} />,
    );
    await waitFor(() => expect(container.querySelector("#dp-log-rows")).not.toBeNull());
    // The next poll fails: rows stay (they are facts), the header turns into
    // the stale note — the list must never look freshly read.
    await waitFor(() =>
      expect(container.querySelector("#dp-log-read-age")?.textContent).toMatch(
        /^couldn't refresh — read \d+ s ago$/,
      ),
    );
    expect(container.querySelector("#dp-log-rows")).not.toBeNull();
    expect(container.querySelector("#dp-log-stale")).toBeNull();
  });

  it("says so when the feed evicted events it could not serve", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok(feed([event("e1")], true))));
    const { container } = render(
      <TaskActivityLog endpoint="/api/notifications" taskId="task-a" pollIntervalMs={60_000} />,
    );
    await waitFor(() => expect(container.querySelector("#dp-log-gap")).not.toBeNull());
  });

  it("drops another task's events when an older board widens the read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        ok(feed([event("mine", { taskId: "task-a" }), event("theirs", { taskId: "task-b" })])),
      ),
    );
    const { container } = render(
      <TaskActivityLog endpoint="/api/notifications" taskId="task-a" pollIntervalMs={60_000} />,
    );
    await waitFor(() => expect(container.querySelector("#dp-log-rows")).not.toBeNull());
    const rows = container.querySelectorAll("#dp-log-rows li");
    expect(rows).toHaveLength(1);
    expect(container.querySelector("#dp-log-theirs")).toBeNull();
  });

  it("lets the newer poll's answer win when an earlier one lands late", async () => {
    const slow = deferredResponse();
    const never = new Promise<Response>(() => {});
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => slow.promise)
      // The first poll answers; every later poll hangs, so nothing can repaint
      // the list between the late first answer and the assertion.
      .mockImplementationOnce(() => ok(feed([event("newer", { type: "task.claim" })])))
      .mockImplementation(() => never);
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <TaskActivityLog endpoint="/api/notifications" taskId="task-a" pollIntervalMs={20} />,
    );
    await waitFor(() => expect(container.querySelector("#dp-log-newer")).not.toBeNull());
    // The FIRST read of the same task lands after the second: an older page
    // must not replace the newer one (the generation guard's real job).
    slow.resolve(feed([event("older", { type: "task.update" })]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.querySelector("#dp-log-newer")).not.toBeNull();
    expect(container.querySelector("#dp-log-older")).toBeNull();
  });

  it("never paints a late answer for the previously open task onto the new one", async () => {
    const slow = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementation(() => ok(feed([event("b-event", { taskId: "task-b" })])));
    vi.stubGlobal("fetch", fetchMock);

    const { container, rerender } = render(
      <TaskActivityLog endpoint="/api/notifications" taskId="task-a" pollIntervalMs={60_000} />,
    );
    rerender(
      <TaskActivityLog endpoint="/api/notifications" taskId="task-b" pollIntervalMs={60_000} />,
    );
    await waitFor(() =>
      expect(container.querySelector("#dp-log-b-event")).not.toBeNull(),
    );
    // Task A's read lands AFTER B is on screen: the generation guard drops it.
    slow.resolve(
      feed([event("a-event", { taskId: "task-a", type: "task.claim" })]),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(container.querySelector("#dp-log-a-event")).toBeNull();
    const rows = container.querySelectorAll("#dp-log-rows li");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("updated");
  });
});
