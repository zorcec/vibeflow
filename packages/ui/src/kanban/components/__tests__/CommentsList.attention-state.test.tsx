// @vitest-environment jsdom
/**
 * Attention state derived from the CURRENT task state (ticket 0752d55c,
 * cold-load gap; never-guess rule ticket p2udqv44cd5zqv1tiqir6ifn).
 *
 * Owner-eyeballed: on a task flagged BEFORE the board opened, the detail
 * Activity tab showed the reason comment PLAIN and NO amber attention
 * change row — the f802e4f diff-event path only creates the row on LIVE
 * transitions while the panel is open. Whenever `needsAttention` is true
 * the feed now derives ONE amber attention row from the flag itself
 * (clear → flagged).
 *
 * The owner's second report ("I expect only the message set via the
 * attention flag highlighted — now it is random") retired the
 * latest-comment proxy this file used to pin: the derived row is placed
 * and attributed from the stored `attentionReasonId` link only, and a
 * link-less record falls back to the task's OWN update time and owner —
 * never to whichever comment happens to be newest.
 *
 * Non-vacuity: the cold-load row test fails on the pre-fix code (no
 * `needsAttention` prop existed, so no attention row renders without a
 * live diff); the never-guess tests fail while the proxy is in place
 * (the row then carries the newest comment's timestamp and author); the
 * tint tests fail where every card keeps the plain style.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  CommentsList,
  type LocalChange,
} from "../shared/CommentsList";
import { formatDate } from "../../utils";
import type { Comment } from "../../types";

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c-1",
    author: "agent",
    text: "Blocked: awaiting design tokens.",
    createdAt: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

function change(overrides: Partial<LocalChange> = {}): LocalChange {
  return {
    field: "status",
    from: "todo",
    to: "in-progress",
    actor: "Ada",
    timestamp: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

function renderFeed(args: {
  comments?: Comment[];
  changes?: LocalChange[];
  needsAttention?: boolean;
  attentionReasonId?: string | null;
  taskUpdatedAt?: string;
  taskAuthorName?: string;
}) {
  return render(
    <CommentsList
      comments={args.comments ?? []}
      localChanges={args.changes ?? []}
      needsAttention={args.needsAttention}
      attentionReasonId={args.attentionReasonId}
      taskUpdatedAt={args.taskUpdatedAt}
      taskAuthorName={args.taskAuthorName}
      loading={false}
      error={null}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("derived attention state row", () => {
  it("renders one amber attention row on cold load (flag on, no live diff)", () => {
    const { container } = renderFeed({
      comments: [comment({ id: "c-reason" })],
      needsAttention: true,
    });
    const rows = container.querySelectorAll(
      '[data-activity="attention-change"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("attention");
    expect(rows[0]?.textContent).toContain("clear");
    expect(rows[0]?.textContent).toContain("flagged");
    const rowStyle = rows[0]?.getAttribute("style") ?? "";
    // Owner ruling: the row is an ordinary activity row — no amber wash or
    // hairline. Only the linked reason comment is marked (pinned below).
    expect(rowStyle).not.toContain("t-warning");
    expect(rowStyle).not.toContain("background");
  });

  it("adds no second row when the live transition row is already present", () => {
    const { container } = renderFeed({
      comments: [comment({ id: "c-reason" })],
      changes: [
        change({
          field: "attention",
          from: "clear",
          to: "flagged",
          timestamp: "2026-10-16T10:00:02.000Z",
        }),
      ],
      needsAttention: true,
    });
    expect(
      container.querySelectorAll('[data-activity="attention-change"]'),
    ).toHaveLength(1);
  });

  it("renders no attention row when the flag is off", () => {
    const { container } = renderFeed({
      comments: [comment({ id: "c-plain" })],
      needsAttention: false,
    });
    expect(
      container.querySelector('[data-activity="attention-change"]'),
    ).toBeNull();
  });

  it("renders no attention row when the prop is absent", () => {
    const { container } = renderFeed({
      comments: [comment({ id: "c-plain" })],
    });
    expect(
      container.querySelector('[data-activity="attention-change"]'),
    ).toBeNull();
  });
});

describe("reason comment tint", () => {
  it("tints the exact linked comment even when newer comments exist (the bug)", () => {
    // Owner-verified repro: flag with "THE REASON", then two plain
    // comments. The proxy would tint the newest plain comment; the link
    // pins the tint on the true reason.
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-reason", text: "THE REASON", createdAt: "2026-10-16T09:00:00.000Z" }),
        comment({ id: "c-new-1", text: "Newer plain note one.", createdAt: "2026-10-16T10:00:00.000Z" }),
        comment({ id: "c-new-2", text: "Newer plain note two.", createdAt: "2026-10-16T11:00:00.000Z" }),
      ],
      needsAttention: true,
      attentionReasonId: "c-reason",
    });
    const tinted = container.querySelectorAll('[data-attention="reason"]');
    expect(tinted).toHaveLength(1);
    expect(tinted[0]?.getAttribute("data-comment-id")).toBe("c-reason");
    expect(tinted[0]?.textContent).toContain("THE REASON");
    // Neither newer comment earns the tint.
    for (const id of ["c-new-1", "c-new-2"]) {
      const plain = container.querySelector(`[data-comment-id="${id}"]`);
      expect(plain?.getAttribute("data-attention")).toBeNull();
      expect(plain?.querySelector('div[style*="t-warning"]')).toBeNull();
    }
  });

  it("tints nothing when the link is absent — no proxy guess (ryqew9bv7ae6b2j6eankkxkb, p2udqv44cd5zqv1tiqir6ifn)", () => {
    // Owner rule: no link → no tint. The retired latest-comment proxy used
    // to paint the newest plain comment (the reported bug); the amber now
    // lives only on the flag row until a linked reason exists.
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-old", text: "Earlier note.", createdAt: "2026-10-16T09:00:00.000Z" }),
        comment({ id: "c-new", text: "Newest note.", createdAt: "2026-10-16T11:00:00.000Z" }),
      ],
      needsAttention: true,
    });
    expect(container.querySelector('[data-attention="reason"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-activity="attention-change"]'),
    ).toHaveLength(1);
  });

  it("places the flag row at the task's own update time, not at the newest comment (p2udqv44cd5zqv1tiqir6ifn)", () => {
    // "Now it is random": the proxy sorted the derived row at the newest
    // comment, so the amber row read as attached to whichever message
    // arrived last. A link-less record now sorts at the task's update
    // time — the flag write — and the fresh comment keeps its own slot.
    const updatedAt = "2026-10-16T09:30:00.000Z";
    const newestCommentAt = "2026-10-16T11:00:00.000Z";
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-new", text: "Newest note.", createdAt: newestCommentAt }),
      ],
      needsAttention: true,
      taskUpdatedAt: updatedAt,
    });
    const row = container.querySelector('[data-activity="attention-change"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain(formatDate(updatedAt));
    expect(row?.textContent).not.toContain(formatDate(newestCommentAt));
  });

  it("attributes the flag row to the task owner, not to the newest comment's author (p2udqv44cd5zqv1tiqir6ifn)", () => {
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-new", author: "Ada", text: "Newest note.", createdAt: "2026-10-16T11:00:00.000Z" }),
      ],
      needsAttention: true,
      taskUpdatedAt: "2026-10-16T09:30:00.000Z",
      taskAuthorName: "Owner",
    });
    const row = container.querySelector('[data-activity="attention-change"]');
    expect(row?.textContent).toContain("Owner");
    expect(row?.textContent).not.toContain("Ada");
  });

  it("tints nothing when the linked comment is gone (no invented reason)", () => {
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-other", text: "Unrelated note.", createdAt: "2026-10-16T10:00:00.000Z" }),
      ],
      needsAttention: true,
      attentionReasonId: "c-vanished",
    });
    expect(container.querySelector('[data-attention="reason"]')).toBeNull();
    // The flag-only row still renders: the flag is real, only the reason
    // comment is gone.
    expect(
      container.querySelectorAll('[data-activity="attention-change"]'),
    ).toHaveLength(1);
  });

  it("tints exactly the reason comment amber when flagged", () => {
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-old", text: "Earlier note.", createdAt: "2026-10-16T09:00:00.000Z" }),
        comment({ id: "c-reason", text: "Blocked: awaiting tokens.", createdAt: "2026-10-16T10:00:00.000Z" }),
      ],
      needsAttention: true,
      attentionReasonId: "c-reason",
    });
    const tinted = container.querySelectorAll('[data-attention="reason"]');
    expect(tinted).toHaveLength(1);
    expect(tinted[0]?.textContent).toContain("Blocked: awaiting tokens.");
    // The tint lives on the comment card (the styled div inside the
    // MarkdownPreview root); jsdom never computes color-mix, so pin the
    // serialized inline style like the row tests do.
    const cardStyle =
      tinted[0]?.querySelector('div[style*="t-warning"]')?.getAttribute("style") ?? "";
    // Tint treatment (e25639f): 4% amber wash over the input surface with
    // a 3px amber left border — no longer the full-card 9%/30% wash.
    expect(cardStyle).toContain(
      "color-mix(in srgb, var(--t-warning) 4%, var(--t-input))",
    );
    expect(cardStyle).toContain("border-left: 3px solid var(--t-warning)");
    // The older comment keeps the plain card.
    const plain = container.querySelector('[data-comment-id="c-old"]');
    expect(plain?.getAttribute("data-attention")).toBeNull();
    expect(plain?.querySelector('div[style*="t-warning"]')).toBeNull();
    expect(
      plain?.querySelector('div[style*="--t-input"]'),
    ).not.toBeNull();
    // Tint on/off must not mix the `border` shorthand with `borderLeft`
    // (ticket p2udqv44cd5zqv1tiqir6ifn): a plain ↔ tinted flip then removes
    // one side of the pair, which React warns about and can render as a
    // stale amber edge on a message whose flag already cleared. Both cards
    // carry the same left longhand, so only its VALUE changes.
    const plainCardStyle =
      plain?.querySelector('div[style*="--t-input"]')?.getAttribute("style") ?? "";
    expect(plainCardStyle).toContain("border-left: 1px solid var(--t-border)");
    expect(plainCardStyle).not.toMatch(/(^|;)\s*border:/);
    expect(cardStyle).not.toMatch(/(^|;)\s*border:/);
  });

  it("tints nothing when the flag is off", () => {
    const { container } = renderFeed({
      comments: [comment({ id: "c-plain" })],
      needsAttention: false,
    });
    expect(container.querySelector('[data-attention="reason"]')).toBeNull();
  });

  it("shows the flag row even when no comment qualifies as the reason", () => {
    const { container } = renderFeed({ comments: [], needsAttention: true });
    expect(
      container.querySelectorAll('[data-activity="attention-change"]'),
    ).toHaveLength(1);
    expect(container.querySelector('[data-attention="reason"]')).toBeNull();
  });
});

describe("attention tint style is re-render safe (p2udqv44cd5zqv1tiqir6ifn)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never mixes the border shorthand with borderLeft when the link comes and goes", () => {
    // The tint follows the link, and the link leaves the task on
    // --clear-attention / a v0 PATCH. A style object that answered with the
    // `border` shorthand when plain and `border` + `borderLeft` when tinted
    // makes React remove one side of the pair on the way back, which logs
    // "Removing a style property during rerender (borderLeft) when a
    // conflicting property is set (border)" in the browser console and can
    // leave a stale amber edge on a message whose flag already cleared.
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const feed = (attentionReasonId: string | null) => (
      <CommentsList
        comments={[
          comment({ id: "c-reason", text: "Blocked: awaiting tokens." }),
          comment({ id: "c-plain", text: "A plain note." }),
        ]}
        localChanges={[]}
        needsAttention
        attentionReasonId={attentionReasonId}
        loading={false}
        error={null}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />
    );
    const { rerender } = render(feed("c-reason"));
    rerender(feed(null));
    rerender(feed("c-plain"));
    expect(errors.filter((m) => m.includes("conflicting property"))).toEqual([]);
  });
});
