// @vitest-environment jsdom
/**
 * Watching badge (ticket cgor65lmpv31cib1ef9zce5m): the header count of live
 * followers of the board's notification feed, and on click the live followers
 * with what each last delivered (ticket ifhh7q2).
 *
 * The component is transport-agnostic (the host passes the endpoint +
 * headers), so these tests drive a stubbed `fetch` and pin the contract the
 * badge must honor: nothing painted before a successful read (no false 0), the
 * last good snapshot survives a transient failure, polling refreshes it, the
 * popover lists each subscriber's activity, and a COUNTS-ONLY snapshot from an
 * older board still renders its per-user breakdown.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  WATCHING_POLL_INTERVAL_MS,
  WatchingBadge,
} from "../WatchingBadge";

function body(total: number, rows: Array<{ user: string; agents: number }>) {
  return {
    total,
    byUser: rows,
    byAgent: rows.map((row) => ({ agent: "agent", count: row.agents })),
  };
}

function withSubscribers(
  subscribers: Array<{
    subscriberId: string;
    user: string;
    agent: string;
    registeredAt: number;
    lastSeenAt: number;
    activity?: { type?: string; taskId?: string; at: number };
  }>,
) {
  return {
    total: subscribers.length,
    byUser: subscribers.map((s) => ({ user: s.user, agents: 1 })),
    byAgent: subscribers.map((s) => ({ agent: s.agent, count: 1 })),
    subscribers,
  };
}

function ok(payload: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    json: async () => payload,
  } as Response);
}

function failed(status = 500): Promise<Response> {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({}),
  } as Response);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WatchingBadge", () => {
  it("renders nothing until the registry answers, then the live count", async () => {
    const fetchMock = vi.fn(() => ok(body(0, [])));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <WatchingBadge endpoint="/api/notifications/subscribers" />,
    );
    expect(container.querySelector("#watching-badge")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The host headers travel with the request (hosted board scope).
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/subscribers",
      expect.objectContaining({
        headers: undefined,
        cache: "no-store",
      }),
    );

    await waitFor(() =>
      expect(container.querySelector("#watching-badge")).not.toBeNull(),
    );
    expect(container.querySelector("#watching-badge-count")?.textContent).toBe(
      "0",
    );
    expect(
      screen.getByRole("button", { name: "Watching 0 agents" }),
    ).toBeInTheDocument();
  });

  it("opens a popover that names each user and its agent count (older board, no subscribers)", async () => {
    // A snapshot WITHOUT the `subscribers` list is what an older board answers.
    // It must keep rendering its counts instead of blanking the popover.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        ok(
          body(3, [
            { user: "Alice", agents: 2 },
            { user: "Bob", agents: 1 },
          ]),
        ),
      ),
    );
    render(
      <WatchingBadge
        endpoint="/api/v0/notifications/subscribers"
        headers={{ "X-Vibeflow-Scope": "board-1" }}
      />,
    );

    const badge = await screen.findByRole("button", {
      name: "Watching 3 agents",
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(badge);
    const popover = screen.getByRole("dialog", {
      name: "Agents following this board",
    });
    expect(popover).toHaveTextContent("Watching this board");
    expect(popover).toHaveTextContent("Alice");
    expect(popover).toHaveTextContent("2 agents");
    expect(popover).toHaveTextContent("Bob");
    expect(popover).toHaveTextContent("1 agent");
    expect(popover).toHaveTextContent("3 agents following");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists each live subscriber with its last delivered event and age", async () => {
    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        ok(
          withSubscribers([
            {
              subscriberId: "sub_live_1",
              user: "zorcec",
              agent: "claude",
              registeredAt: now - 60_000,
              lastSeenAt: now - 2_000,
              activity: {
                type: "task.claim",
                taskId: "ifhh7q2jukxhqcrs5kfo6mb8",
                at: now - 12_400,
              },
            },
          ]),
        ),
      ),
    );

    render(
      <WatchingBadge endpoint="/api/v0/notifications/subscribers" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Watching 1 agent" }),
    );

    const popover = screen.getByRole("dialog", {
      name: "Agents following this board",
    });
    expect(popover).toHaveTextContent("claude");
    // `<user> · <last event type> · <short task id>` on the activity line.
    expect(popover).toHaveTextContent(/zorcec · task\.claim · ifhh7q2/);
    // `shortId` is the kanban's 7-char display id.
    expect(popover).not.toHaveTextContent("ifhh7q2jukxhqcrs5kfo6mb8");
    expect(popover).toHaveTextContent("12 s ago");
    expect(popover).toHaveTextContent("1 agent following");
  });

  it("derives idle wording from a live heartbeat with a stale delivery", async () => {
    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        ok(
          withSubscribers([
            {
              subscriberId: "sub_idle",
              user: "zorcec",
              agent: "pi",
              registeredAt: now - 600_000,
              // The heartbeat is alive; only the delivery is old.
              lastSeenAt: now - 5_000,
              activity: {
                type: "task.comment",
                taskId: "ifhh7q2jukxhqcrs5kfo6mb8",
                at: now - 6 * 60_000,
              },
            },
            {
              subscriberId: "sub_fresh",
              user: "zorcec",
              agent: "claude",
              registeredAt: now,
              lastSeenAt: now,
            },
          ]),
        ),
      ),
    );

    render(
      <WatchingBadge endpoint="/api/notifications/subscribers" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Watching 2 agents" }),
    );

    const popover = screen.getByRole("dialog", {
      name: "Agents following this board",
    });
    expect(popover).toHaveTextContent("idle, watching");
    // A follower that delivered nothing says so — it does not read as idle.
    expect(popover).toHaveTextContent("no events yet");
    expect(popover).toHaveTextContent("listening");
  });

  it("polls, and a failed poll keeps the last good count instead of clearing it", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => ok(body(1, [{ user: "Alice", agents: 1 }])))
      .mockImplementation(() => failed());
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WatchingBadge
        endpoint="/api/notifications/subscribers"
        pollIntervalMs={10}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Watching 1 agent" })),
    );
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    // The failure did not blank the badge.
    expect(
      screen.getByRole("button", { name: "Watching 1 agent" }),
    ).toBeInTheDocument();
  });

  it("refreshes the count on the next poll", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => ok(body(0, [])))
      .mockImplementation(() =>
        ok(
          body(1, [{ user: "Alice", agents: 1 }]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WatchingBadge
        endpoint="/api/notifications/subscribers"
        pollIntervalMs={10}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Watching 0 agents" }),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Watching 1 agent" }),
      ).toBeInTheDocument(),
    );
    expect(WATCHING_POLL_INTERVAL_MS).toBe(10_000);
  });

  it("does not render a false 0 when the very first read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => failed(404)));
    const { container } = render(
      <WatchingBadge
        endpoint="/api/notifications/subscribers"
        pollIntervalMs={10}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("#watching-badge")).toBeNull();
  });
});
