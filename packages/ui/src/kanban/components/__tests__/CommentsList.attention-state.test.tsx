// @vitest-environment jsdom
/**
 * Attention state derived from the CURRENT task state (ticket 0752d55c,
 * cold-load gap).
 *
 * Owner-eyeballed: on a task flagged BEFORE the board opened, the detail
 * Activity tab showed the reason comment PLAIN and NO amber attention
 * change row — the f802e4f diff-event path only creates the row on LIVE
 * transitions while the panel is open. Whenever `needsAttention` is true
 * the feed now derives ONE amber attention row from the flag itself
 * (clear → flagged), and the reason comment (the latest surviving user
 * comment — the same proxy `attentionClaimAlert` reads) earns the same
 * amber wash. A live transition row already in `localChanges` wins: no
 * second row.
 *
 * Non-vacuity: the cold-load row test fails on the pre-fix code (no
 * `needsAttention` prop existed, so no attention row renders without a
 * live diff); the tint tests fail where every card keeps the plain style.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  CommentsList,
  attentionReasonComment,
  type LocalChange,
} from "../shared/CommentsList";
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
}) {
  return render(
    <CommentsList
      comments={args.comments ?? []}
      localChanges={args.changes ?? []}
      needsAttention={args.needsAttention}
      attentionReasonId={args.attentionReasonId}
      loading={false}
      error={null}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("attentionReasonComment proxy", () => {
  it("returns null for an empty or missing list", () => {
    expect(attentionReasonComment([])).toBeNull();
    expect(attentionReasonComment(null)).toBeNull();
    expect(attentionReasonComment(undefined)).toBeNull();
  });

  it("picks the latest surviving user comment", () => {
    const older = comment({ id: "c-old", createdAt: "2026-10-16T09:00:00.000Z" });
    const newer = comment({ id: "c-new", createdAt: "2026-10-16T11:00:00.000Z" });
    expect(attentionReasonComment([newer, older])?.id).toBe("c-new");
    expect(attentionReasonComment([older, newer])?.id).toBe("c-new");
  });

  it("skips system, deleted, and blank comments", () => {
    const reason = comment({ id: "c-reason", createdAt: "2026-10-16T09:00:00.000Z" });
    const system = comment({
      id: "c-sys",
      type: "system",
      text: "**Cannot verify:** no harness here",
      createdAt: "2026-10-16T12:00:00.000Z",
    });
    const deleted = comment({
      id: "c-del",
      deleted: true,
      createdAt: "2026-10-16T13:00:00.000Z",
    });
    const blank = comment({
      id: "c-blank",
      text: "   ",
      createdAt: "2026-10-16T14:00:00.000Z",
    });
    expect(attentionReasonComment([reason, system, deleted, blank])?.id).toBe(
      "c-reason",
    );
  });
});

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
    expect(rowStyle).toContain(
      "color-mix(in srgb, var(--t-warning) 9%, transparent)",
    );
    expect(rowStyle).toContain(
      "color-mix(in srgb, var(--t-warning) 30%, transparent)",
    );
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

  it("falls back to the latest surviving comment when the link is absent (older records / online)", () => {
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-old", text: "Earlier note.", createdAt: "2026-10-16T09:00:00.000Z" }),
        comment({ id: "c-new", text: "Newest note.", createdAt: "2026-10-16T11:00:00.000Z" }),
      ],
      needsAttention: true,
    });
    const tinted = container.querySelectorAll('[data-attention="reason"]');
    expect(tinted).toHaveLength(1);
    expect(tinted[0]?.getAttribute("data-comment-id")).toBe("c-new");
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
