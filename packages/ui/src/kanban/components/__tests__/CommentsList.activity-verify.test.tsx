// @vitest-environment jsdom
/**
 * Verify entries in the activity feed (80df86ed).
 *
 * An agent attesting a verdict does not leave a free-text message — for
 * `pass`/`fail` the verdict lives on the task and the transition is what shows
 * up in the feed, and `cannot` arrives as a machine-written system comment. So
 * the feed styles exactly those two shapes and nothing else:
 *
 *   - a status change that CARRIES the tri-state `verified` flag AND landed in
 *     a lane that draws a verdict (`VERDICT_LANES`, single-sourced from
 *     VerifyIndicator) → `activity-verify--pass|--fail`
 *   - the `**Cannot verify:**` system comment → `activity-verify--cannot`
 *
 * Every ordinary comment and every verdict-less status change must stay plain —
 * that is the over-match these tests pin.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  CommentsList,
  isVerifyEntry,
  type ActivityItem,
  type LocalChange,
} from "../shared/CommentsList";
import type { Comment, TaskStatus } from "../../types";

function renderFeed(changes: LocalChange[] = [], comments: Comment[] = []) {
  return render(
    <CommentsList
      comments={comments}
      localChanges={changes}
      loading={false}
      error={null}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

function verifyChange(
  verified: boolean | undefined,
  toStatus?: TaskStatus,
): LocalChange {
  return {
    field: "status",
    from: "Todo",
    to: "Review",
    actor: "🤖 Agent",
    timestamp: "2026-10-06T10:00:00.000Z",
    source: "cli",
    toStatus: toStatus ?? "review",
    ...(verified === undefined ? {} : { verified }),
  };
}

describe("activity verify entries", () => {
  it("styles a status change carrying verified=true as a pass entry", () => {
    const { container } = renderFeed([verifyChange(true)]);
    const entry = container.querySelector(".activity-verify");
    expect(entry).not.toBeNull();
    expect(entry).toHaveClass("activity-verify--pass");
    expect(entry?.getAttribute("title")).toContain(
      "IS implemented correctly",
    );
  });

  it("styles a status change carrying verified=false as a fail entry", () => {
    const { container } = renderFeed([verifyChange(false)]);
    const entry = container.querySelector(".activity-verify");
    expect(entry).not.toBeNull();
    expect(entry).toHaveClass("activity-verify--fail");
    expect(entry?.getAttribute("title")).toContain(
      "NOT implemented correctly",
    );
  });

  it("a normal agent comment keeps its card geometry (verify entries join it, not vice versa)", () => {
    const agentComment: Comment = {
      id: "c-agent",
      author: "agent",
      text: "Implemented the widget.",
      createdAt: "2026-10-06T10:00:00.000Z",
    };
    const { container } = renderFeed([], [agentComment]);
    expect(container.querySelector(".activity-verify")).toBeNull();
    const cards = Array.from(container.querySelectorAll("div")).filter(
      (d) => (d as HTMLElement).style.padding === "10px 14px",
    ) as HTMLElement[];
    expect(cards).toHaveLength(1);
    expect(cards[0].style.borderRadius).toBe("8px");
    expect(cards[0].style.fontSize).toBe("12px");
    expect(cards[0].style.lineHeight).toBe("1.6");
    expect(cards[0].style.background).toBe("var(--t-input)");
  });

  it("leaves a verdict-less status change plain", () => {
    const { container } = renderFeed([verifyChange(undefined)]);
    expect(container.querySelector(".activity-verify")).toBeNull();
  });

  it("leaves a verdict on a non-verdict lane plain (VERDICT_LANES gate)", () => {
    const { container } = renderFeed([
      verifyChange(true, "in-progress" as TaskStatus),
    ]);
    expect(container.querySelector(".activity-verify")).toBeNull();
  });

  it("cannot entry orders who, verdict badge, then detail", () => {
    const longReason =
      "No defect exists to verify: the save and render flow was proven end to end " +
      "on the live app (picker \u2192 boards.icon \u2192 header shows the icon, brand mark absent). " +
      "The symptom could not be reproduced as a bug here; the measurements point elsewhere.";
    const cannot: Comment = {
      id: "c-long",
      author: "agent",
      type: "system",
      text: `**Cannot verify:** ${longReason}`,
      createdAt: "2026-10-06T10:01:00.000Z",
    };
    const { container } = renderFeed([], [cannot]);
    const entry = container.querySelector(".activity-verify.activity-verify--cannot");
    expect(entry).not.toBeNull();
    const text = entry!.textContent ?? "";
    // Header first: who said it, then the verdict badge…
    // Attribution (0b7c45c5): the fixture carries no joined human name, so
    // the viewer fallback ('You' — renderFeed passes no gitUserName) names
    // the human and the badge marks the agent surface. Order is unchanged.
    expect(text).toContain("\u{1F464} You");
    expect(text).toContain("\u{1F916}");
    expect(text).toContain("\u26a0 Cannot verify");
    // …then the detail, with the verdict prefix NOT repeated in the body.
    expect(text).toContain(longReason);
    expect(text.indexOf("\u{1F916}")).toBeLessThan(text.indexOf("\u26a0 Cannot verify"));
    expect(text.indexOf("\u26a0 Cannot verify")).toBeLessThan(text.indexOf(longReason));
  });

  it("cannot entry uses the agent-message card geometry", () => {
    const cannot: Comment = {
      id: "c-card",
      author: "agent",
      type: "system",
      text: "**Cannot verify:** offline target",
      createdAt: "2026-10-06T10:01:00.000Z",
    };
    const { container } = renderFeed([], [cannot]);
    const entry = container.querySelector(".activity-verify--cannot") as HTMLElement;
    expect(entry).not.toBeNull();
    // Body card: same radius/padding/type/line-height as a normal comment card.
    const cards = Array.from(entry.querySelectorAll("div")).filter(
      (d) => (d as HTMLElement).style.padding === "10px 14px",
    ) as HTMLElement[];
    expect(cards).toHaveLength(1);
    expect(cards[0].style.borderRadius).toBe("8px");
    expect(cards[0].style.fontSize).toBe("12px");
    expect(cards[0].style.lineHeight).toBe("1.6");
    expect(cards[0].style.overflowWrap).toBe("break-word");
    // Warning colour language, existing tokens only.
    expect(cards[0].style.background).toBe("var(--t-warning-soft)");
    expect(cards[0].style.border).toContain("var(--t-warning)");
  });

  it("pass/fail entries badge the verdict and keep the from/to pills", () => {
    const pass = renderFeed([verifyChange(true)]);
    const passEntry = pass.container.querySelector(".activity-verify--pass");
    expect(passEntry?.textContent).toContain("Pass");
    expect(passEntry?.textContent).toContain("Todo");
    expect(passEntry?.textContent).toContain("Review");
    const fail = renderFeed([verifyChange(false)]);
    expect(fail.container.querySelector(".activity-verify--fail")?.textContent).toContain("Fail");
  });

  it("leaves an ordinary comment plain but flags the cannot-verify system comment", () => {
    const plain: Comment = {
      id: "c1",
      author: "agent",
      text: "Implemented the widget.",
      createdAt: "2026-10-06T10:00:00.000Z",
    };
    const cannot: Comment = {
      id: "c2",
      author: "agent",
      type: "system",
      text: "**Cannot verify:** no annotated URL on this task",
      createdAt: "2026-10-06T10:01:00.000Z",
    };
    const { container } = renderFeed([], [plain, cannot]);
    expect(container.querySelector(".activity-verify--cannot")).not.toBeNull();
    expect(container.querySelector(".activity-verify")?.getAttribute("title"))
      .toContain("unverifiable");
    // Exactly ONE flagged entry: the plain comment must not match.
    expect(container.querySelectorAll(".activity-verify")).toHaveLength(1);
  });
});

describe("isVerifyEntry predicate", () => {
  const change = (overrides: Partial<LocalChange> = {}): ActivityItem =>
    ({
      kind: "change",
      sortKey: "2026-10-06T10:00:00.000Z",
      ...verifyChange(true),
      ...overrides,
    }) as ActivityItem;

  it("accepts a verdict-carrying change in a verdict lane", () => {
    expect(isVerifyEntry(change())).toBe(true);
    expect(isVerifyEntry(change({ verified: false }))).toBe(true);
  });

  it("rejects verdict-less changes, non-verdict lanes and plain comments", () => {
    expect(isVerifyEntry(change({ verified: undefined }))).toBe(false);
    expect(
      isVerifyEntry(change({ toStatus: "todo" as TaskStatus })),
    ).toBe(false);
    expect(
      isVerifyEntry({
        kind: "comment",
        sortKey: "2026-10-06T10:00:00.000Z",
        comment: {
          id: "c1",
          author: "agent",
          text: "looks good",
          createdAt: "2026-10-06T10:00:00.000Z",
        },
      }),
    ).toBe(false);
  });

  it("accepts the cannot-verify system comment", () => {
    expect(
      isVerifyEntry({
        kind: "comment",
        sortKey: "2026-10-06T10:00:00.000Z",
        comment: {
          id: "c2",
          author: "agent",
          type: "system",
          text: "**Cannot verify:** offline target",
          createdAt: "2026-10-06T10:00:00.000Z",
        },
      }),
    ).toBe(true);
  });
});
