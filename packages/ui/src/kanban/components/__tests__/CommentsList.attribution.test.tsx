// @vitest-environment jsdom
/**
 * Shared attribution (ticket 0b7c45c5 — "Agent icon").
 *
 * ONE rule for every surface, both boards: render the HUMAN behind the
 * row, and add an agent badge when the change came from an agent surface.
 * The card, the details tab and the activity feed all read through the
 * same helper, so the same record renders the same attribution everywhere.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  CommentsList,
  type LocalChange,
} from "../shared/CommentsList";
import { BadgeCluster } from "../TaskCard";
import type { Comment } from "../../types";

const GIT_USER = "Tomislav Zorcec";

function renderFeed(changes: LocalChange[] = [], comments: Comment[] = []) {
  return render(
    <CommentsList
      comments={comments}
      localChanges={changes}
      loading={false}
      error={null}
      gitUserName={GIT_USER}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

function agentComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "c-agent-1",
    author: "agent",
    authorName: "Tomislav Zorcec",
    text: "Implemented the widget.",
    createdAt: "2026-10-06T10:00:00.000Z",
    ...overrides,
  };
}

describe("shared attribution (agent icon)", () => {
  it("an agent comment renders the human name WITH the agent badge (guard)", () => {
    // The server joins the human behind an agent write (authorId), so the
    // row carries both halves. The old vocabulary-first rule dropped the
    // human and rendered a bare '🤖 Agent' — that is the flip this ticket
    // removes: the feed must name the user and badge the agent surface.
    const { container } = renderFeed([], [agentComment()]);
    const text = container.textContent ?? "";
    expect(text).toContain("Tomislav Zorcec");
    expect(text).toContain("🤖");
  });

  it("a human-only comment renders the human with no agent badge", () => {
    const { container } = renderFeed([], [
      {
        id: "c-human-1",
        author: "user",
        authorName: "Tomislav Zorcec",
        text: "Looks good.",
        createdAt: "2026-10-06T10:00:00.000Z",
      },
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("Tomislav Zorcec");
    expect(text).not.toContain("🤖");
  });

  it("unknown attribution renders neutrally — no badge, never a bare agent", () => {
    const { container } = render(
      <CommentsList
        comments={[
          {
            id: "c-unknown-1",
            author: "user",
            text: "Mystery row.",
            createdAt: "2026-10-06T10:00:00.000Z",
          },
        ]}
        localChanges={[]}
        loading={false}
        error={null}
        gitUserName=""
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Unknown");
    expect(text).not.toContain("🤖");
  });

  it("activity feed matches the card for the same agent record", () => {
    // Same human + same agent involvement, two surfaces: the feed change
    // row and the card assignee pill must agree (human named, agent badged).
    const change: LocalChange = {
      field: "status",
      from: "Todo",
      to: "In Progress",
      actor: "Tomislav Zorcec",
      agent: true,
      timestamp: "2026-10-06T10:00:00.000Z",
    };
    const feed = renderFeed([change]);
    const feedText = feed.container.textContent ?? "";
    expect(feedText).toContain("Tomislav Zorcec");
    expect(feedText).toContain("🤖");
    feed.unmount();

    const card = render(
      <BadgeCluster
        type="Task"
        assigneeName="Tomislav Zorcec"
        assigneeIsAgent={true}
      />,
    );
    const cardText = card.container.textContent ?? "";
    // Initials pill, not the full name — but the badge and the human in
    // the title must both be there.
    expect(cardText).toContain("🤖");
    const pill = card.container.querySelector('[title="Tomislav Zorcec"]');
    expect(pill).not.toBeNull();
    card.unmount();
  });

  it("a marker-only change row keeps the legacy agent rendering", () => {
    // Rows that carry the broadcast marker but no human (pre-fix live
    // rows, fixtures): agent-ness is proven by the marker literal itself,
    // the human is honestly unknown — render the marker, not a guess.
    const { container } = renderFeed([
      {
        field: "status",
        from: "Todo",
        to: "In Progress",
        actor: "🤖 Agent",
        timestamp: "2026-10-06T10:00:00.000Z",
      },
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("🤖 Agent");
    expect(text).not.toContain("👤 🤖 Agent");
  });
});
