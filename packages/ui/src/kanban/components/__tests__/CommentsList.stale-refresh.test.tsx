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
  it("loading with saved comments keeps the old text and shows a corner loader, not an in-flow line", () => {
    const { container } = renderFeed(
      [comment("c-1", "Saved entry", "2026-10-15T10:00:00.000Z")],
      true,
      null,
    );
    expect(container.textContent).toContain("Saved entry");
    expect(container.textContent).not.toContain("Loading…");
    // 5a6fad12: the in-flow "Updating…" text is gone — a compact overlay
    // spinner carries the state without taking column space.
    expect(container.textContent).not.toContain("Updating");
    const note = container.querySelector("#dp-activity-updating");
    expect(note).not.toBeNull();
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.getAttribute("aria-label")).toBe("Refreshing activity");
    expect(note?.querySelector(".spinner")).not.toBeNull();
    expect((note as HTMLElement)?.style.position).toBe("absolute");
  });

  it("loading with no comments still shows the full Loading state", () => {
    const { container } = renderFeed([], true, null);
    expect(container.textContent).toContain("Loading…");
  });

  it("a failed refresh with saved comments keeps the old text with an overlay stale notice", () => {
    const { container } = renderFeed(
      [comment("c-1", "Saved entry", "2026-10-15T10:00:00.000Z")],
      false,
      "failed",
    );
    expect(container.textContent).toContain("Saved entry");
    expect(container.textContent).not.toContain("Failed to load.");
    // 5a6fad12: the honest stale copy stays word-for-word, but floats over
    // the feed instead of pushing rows down.
    const stale = container.querySelector("#dp-activity-stale");
    expect(stale).not.toBeNull();
    expect(stale?.textContent).toContain(
      "Couldn\u2019t refresh — showing saved entries.",
    );
    expect(stale?.getAttribute("role")).toBe("status");
    expect((stale as HTMLElement)?.style.position).toBe("absolute");
  });

  it("a failed first load with no comments still shows Failed to load", () => {
    const { container } = renderFeed([], false, "failed");
    expect(container.textContent).toContain("Failed to load.");
  });
});

describe("refresh loader honors prefers-reduced-motion", () => {
  function setReducedMotion(matches: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: () => ({
        matches,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  }

  it("spins by default and renders a static ring under reduced motion", () => {
    // No matchMedia mock: the hook falls back to animated.
    const animated = renderFeed(
      [comment("c-1", "Saved entry", "2026-10-15T10:00:00.000Z")],
      true,
      null,
    );
    expect(
      animated.container.querySelector("#dp-activity-updating .spinner"),
    ).not.toBeNull();
    animated.unmount();

    setReducedMotion(true);
    const reduced = renderFeed(
      [comment("c-1", "Saved entry", "2026-10-15T10:00:00.000Z")],
      true,
      null,
    );
    const note = reduced.container.querySelector("#dp-activity-updating");
    // The state signal stays (role + label) but nothing animates.
    expect(note).not.toBeNull();
    expect(note?.getAttribute("aria-label")).toBe("Refreshing activity");
    expect(note?.querySelector(".spinner")).toBeNull();
    reduced.unmount();
    setReducedMotion(false);
  });
});
