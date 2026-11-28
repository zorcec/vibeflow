// @vitest-environment jsdom
/**
 * The Watching popover's agent status line (ticket c9ei8dck7tpcog0wcypddren):
 * ONE line under the agent's activity row when — and only when — the registry
 * reports a status. Pins the badge's honesty rules: absence (or a malformed
 * value) renders nothing, never a placeholder; the line ages with the badge's
 * own `agoLabel` wording; a report older than WATCHING_IDLE_AFTER_MS reads
 * muted `idle` with the raw text gone (a frozen status would lie, exactly
 * like the activity row); and a long report ellipsises without widening the
 * popover. Counts/aggregates, the legacy no-subscribers snapshot and the
 * closed-badge single fetch are pinned in WatchingBadge.test.tsx and stay
 * green alongside this file.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { WatchingBadge } from "../WatchingBadge";

function withSubscribers(
  subscribers: Array<{
    subscriberId: string;
    user: string;
    agent: string;
    registeredAt: number;
    lastSeenAt: number;
    activity?: { type?: string; taskId?: string; at: number };
    status?: { text: string; at: number };
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render the badge with the given snapshot and open its popover. */
async function openPopover(payload: unknown) {
  vi.stubGlobal("fetch", vi.fn(() => ok(payload)));
  render(<WatchingBadge endpoint="/api/notifications/subscribers" />);
  const badge = await screen.findByRole("button", {
    name: /Watching \d+ agent/,
  });
  fireEvent.click(badge);
  return screen.getByRole("dialog", { name: "Agents following this board" });
}

describe("WatchingBadge status line", () => {
  it("renders no line at all when the follower never sent a status", async () => {
    const now = Date.now();
    const popover = await openPopover(
      withSubscribers([
        {
          subscriberId: "sub_a",
          user: "local",
          agent: "pi",
          registeredAt: now,
          lastSeenAt: now,
          activity: { type: "task.comment", at: now - 5_000 },
        },
      ]),
    );
    expect(screen.queryByText("status")).toBeNull();
    expect(popover.textContent).not.toContain("fixing");
    // The activity row is untouched: it still reports the delivery facts.
    expect(popover).toHaveTextContent("task.comment");
    expect(popover).toHaveTextContent("5 s ago");
  });

  it("stays absent when the status on the wire is malformed", async () => {
    const now = Date.now();
    const popover = await openPopover({
      total: 1,
      byUser: [{ user: "local", agents: 1 }],
      byAgent: [{ agent: "pi", count: 1 }],
      subscribers: [
        {
          subscriberId: "sub_a",
          user: "local",
          agent: "pi",
          registeredAt: now,
          lastSeenAt: now,
          // Empty text: dropped by statusFrom, so no line — absence stays absent.
          status: { text: "", at: now },
        },
      ],
    });
    expect(screen.queryByText("status")).toBeNull();
    expect(popover).toHaveTextContent("listening");
  });

  it("renders the report, its uppercase label and its age on one line", async () => {
    const now = Date.now();
    const popover = await openPopover(
      withSubscribers([
        {
          subscriberId: "sub_a",
          user: "local",
          agent: "pi",
          registeredAt: now,
          lastSeenAt: now,
          activity: { type: "task.comment", at: now - 5_000 },
          status: { text: "fixing the port resolver", at: now - 41_000 },
        },
      ]),
    );
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(popover).toHaveTextContent("“fixing the port resolver”");
    // The badge's own agoLabel wording, from the SET time — not lastSeenAt.
    expect(popover).toHaveTextContent("41 s ago");
    // The status sits UNDER the activity row, not instead of it.
    expect(popover).toHaveTextContent("5 s ago");
    expect(popover.textContent!.indexOf("task.comment")).toBeLessThan(
      popover.textContent!.indexOf("fixing the port resolver"),
    );
  });

  it("a report older than the idle window reads muted idle, raw text gone", async () => {
    const now = Date.now();
    await openPopover(
      withSubscribers([
        {
          subscriberId: "sub_a",
          user: "local",
          agent: "pi",
          registeredAt: now - 600_000,
          lastSeenAt: now - 5_000,
          activity: { type: "task.comment", at: now - 5_000 },
          status: { text: "halfway there", at: now - 6 * 60_000 },
        },
      ]),
    );
    const idle = screen.getByText("idle");
    expect(idle).toBeInTheDocument();
    // The raw report is GONE — a frozen status would lie about freshness.
    expect(screen.queryByText("“halfway there”")).toBeNull();
    // Muted: the line renders in the faint token, never the body colour.
    expect(idle.closest("div")!.style.color).toBe("var(--t-text-faint)");
    expect(screen.getByText("status").closest("div")!.style.color).toBe(
      "var(--t-text-faint)",
    );
    // The age stays honest — six minutes, not a reset heartbeat.
    expect(idle.parentElement).toHaveTextContent("6 min ago");
  });

  it("a long report ellipsises without widening the popover", async () => {
    const now = Date.now();
    const longText = "s".repeat(300);
    const popover = await openPopover(
      withSubscribers([
        {
          subscriberId: "sub_a",
          user: "local",
          agent: "pi",
          registeredAt: now,
          lastSeenAt: now,
          status: { text: longText, at: now - 1_000 },
        },
      ]),
    );
    // The popover keeps its cap: one long line must not stretch the surface.
    expect(popover.style.maxWidth).toBe("280px");
    const report = screen.getByText(`“${longText}”`);
    expect(report.style.textOverflow).toBe("ellipsis");
    expect(report.style.whiteSpace).toBe("nowrap");
    expect(report.style.overflow).toBe("hidden");
    // The age survives the squeeze — it is the short, fixed part of the row.
    expect(popover).toHaveTextContent("1 s ago");
  });
});
