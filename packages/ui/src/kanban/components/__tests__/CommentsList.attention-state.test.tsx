// @vitest-environment jsdom
/**
 * No attention change row (ticket nfmnf5bn9iu5jvarymp8lo8b; derived-row
 * era ticket 0752d55c, never-guess rule ticket p2udqv44cd5zqv1tiqir6ifn).
 *
 * Owner order: flagging activity is not needed — the amber reason comment
 * is the only feed record of a flag. The feed renders NO derived
 * "changed attention" row on cold load, NO live-transition row on a flag
 * flip, and drops STORED `{ field: "attention" }` entries from legacy
 * records. The reason-comment tint pins below are unchanged: the linked
 * comment still tints amber, and with no link nothing tints (never a
 * proxy guess).
 *
 * Non-vacuity: the absence tests fail on the pre-fix code (which derived
 * one row from the flag and rendered every stored `attention` entry);
 * the tint tests fail where every card keeps the plain style.
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

describe("no attention change row", () => {
  it("renders no attention row on cold load (flag on, no live diff)", () => {
    const { container } = renderFeed({
      comments: [comment({ id: "c-reason" })],
      needsAttention: true,
    });
    expect(
      container.querySelectorAll('[data-activity="attention-change"]'),
    ).toHaveLength(0);
    expect(container.textContent).not.toContain("attention");
  });

  it("drops a stored live-transition row instead of rendering it", () => {
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
    ).toHaveLength(0);
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
    // Owner rule: no link → no tint. No attention row either: the flag
    // reads only as the bell until a linked reason exists.
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
    ).toHaveLength(0);
  });

  it("leaves the newest comment in its own slot with no flag row beside it (p2udqv44cd5zqv1tiqir6ifn)", () => {
    // The retired proxy sorted a derived row at the newest comment, so the
    // amber row read as attached to whichever message arrived last. Now
    // there is no row at all: the fresh comment keeps its own slot and the
    // feed names no attention field.
    const updatedAt = "2026-10-16T09:30:00.000Z";
    const newestCommentAt = "2026-10-16T11:00:00.000Z";
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-new", text: "Newest note.", createdAt: newestCommentAt }),
      ],
      needsAttention: true,
      taskUpdatedAt: updatedAt,
    });
    expect(
      container.querySelector('[data-activity="attention-change"]'),
    ).toBeNull();
    expect(container.textContent).toContain(formatDate(newestCommentAt));
    expect(container.textContent).not.toContain("attention");
  });

  it("names no attention actor anywhere without the row (p2udqv44cd5zqv1tiqir6ifn)", () => {
    const { container } = renderFeed({
      comments: [
        comment({ id: "c-new", author: "Ada", text: "Newest note.", createdAt: "2026-10-16T11:00:00.000Z" }),
      ],
      needsAttention: true,
      taskUpdatedAt: "2026-10-16T09:30:00.000Z",
      taskAuthorName: "Owner",
    });
    expect(
      container.querySelector('[data-activity="attention-change"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("attention");
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
    // No fallback row either: the flag is real but only the bell shows it.
    expect(
      container.querySelectorAll('[data-activity="attention-change"]'),
    ).toHaveLength(0);
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

  it("shows no flag row when no comment qualifies as the reason", () => {
    const { container } = renderFeed({ comments: [], needsAttention: true });
    expect(
      container.querySelectorAll('[data-activity="attention-change"]'),
    ).toHaveLength(0);
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
