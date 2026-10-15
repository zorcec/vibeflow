// @vitest-environment jsdom
/**
 * Stale-while-revalidate activity feed (vibeflow task fa0d3d0e).
 *
 * Sending a comment used to blank the whole feed: `loadComments` flips
 * `loading` on, and `CommentsList` rendered a bare "Loading…" until the
 * refetch landed — old entries vanished, then the list popped back with a
 * delay. The feed now keeps saved rows during a refresh and carries the
 * state in a slim inline note; the full Loading/Failed states render only
 * when there is nothing to keep.
 *
 * Non-vacuity: the "keeps old rows" cases fail on the old code (it returned
 * early on `loading`/`error` regardless of content — the old text is gone
 * from the document), and the empty cases guard the loading contract for a
 * freshly opened panel.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommentsList } from "../shared/CommentsList";
import type { Comment } from "../../types";

function comment(id: string, text: string, createdAt: string): Comment {
  return { id, author: "Ada", text, createdAt };
}

function renderFeed(comments: Comment[], loading: boolean, error: string | null) {
  return render(
    <CommentsList
      comments={comments}
      loading={loading}
      error={error}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe("activity feed keeps saved rows during a refresh", () => {
  it("loading with saved comments keeps the old text and notes the refresh inline", () => {
    const { container } = renderFeed(
      [comment("c-1", "Saved entry", "2026-10-15T10:00:00.000Z")],
      true,
      null,
    );
    expect(container.textContent).toContain("Saved entry");
    expect(container.textContent).not.toContain("Loading…");
    expect(container.querySelector("#dp-activity-updating")).not.toBeNull();
  });

  it("loading with no comments still shows the full Loading state", () => {
    const { container } = renderFeed([], true, null);
    expect(container.textContent).toContain("Loading…");
  });

  it("a failed refresh with saved comments keeps the old text with a stale note", () => {
    const { container } = renderFeed(
      [comment("c-1", "Saved entry", "2026-10-15T10:00:00.000Z")],
      false,
      "failed",
    );
    expect(container.textContent).toContain("Saved entry");
    expect(container.textContent).not.toContain("Failed to load.");
    expect(container.querySelector("#dp-activity-stale")).not.toBeNull();
  });

  it("a failed first load with no comments still shows Failed to load", () => {
    const { container } = renderFeed([], false, "failed");
    expect(container.textContent).toContain("Failed to load.");
  });
});
