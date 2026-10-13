// @vitest-environment jsdom
/**
 * Activity feed motion (vibeflow task b6729a0a, round 2).
 *
 * The live comment-edit propagation worked but every re-render BLINKED: the
 * group containers used index keys (`group-${gIdx}`), so each prepended row
 * remounted the whole subtree. Rows now carry content-stable keys, new rows
 * mount with `.activity-enter` (fade/slide ~180ms), in-place text edits flash
 * the changed row (`.activity-flash`), and both are skipped entirely under
 * `prefers-reduced-motion`.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommentsList, activityItemKey } from "../shared/CommentsList";
import type { Comment } from "../../types";

function comment(
  id: string,
  text: string,
  createdAt: string,
  authorName = "Ada",
): Comment {
  return { id, author: "user-1", authorName, text, createdAt };
}

function renderFeed(comments: Comment[]) {
  return render(
    <CommentsList
      comments={comments}
      loading={false}
      error={null}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

/** The row wrapper for a comment's text (MarkdownPreview renders it). */
function rowForText(container: HTMLElement, text: string): HTMLElement | null {
  const els = Array.from(container.querySelectorAll("div"));
  const match = els.find((d) => d.textContent === text);
  // The MarkdownPreview card holds exactly the comment text; climb to the
  // row root (the group/comment wrapper carrying the animation class).
  return (
    (match?.closest(".group\\/comment") as HTMLElement | null) ??
    (match?.closest("[class*='activity-']") as HTMLElement | null) ??
    null
  );
}

function setReducedMotion(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

describe("activity stable keys (no full-list remount blink)", () => {
  it("keys comments by id, not position", () => {
    expect(
      activityItemKey({
        kind: "comment",
        sortKey: "2026-10-13T10:00:00.000Z",
        comment: comment("c-1", "hi", "2026-10-13T10:00:00.000Z"),
      }),
    ).toBe("comment:c-1");
  });

  it("a newly added row animates in while existing rows keep their DOM nodes", () => {
    const old = comment("c-old", "Old text", "2026-10-13T10:00:00.000Z");
    const { container, rerender } = renderFeed([old]);
    const oldRow = rowForText(container, "Old text");
    expect(oldRow).not.toBeNull();
    expect(container.querySelectorAll(".activity-enter")).toHaveLength(0);

    const fresh = comment("c-new", "New text", "2026-10-13T10:01:00.000Z");
    rerender(
      <CommentsList
        comments={[old, fresh]}
        loading={false}
        error={null}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const entering = container.querySelectorAll(".activity-enter");
    expect(entering).toHaveLength(1);
    expect(entering[0].textContent).toContain("New text");
    // The old row was reconciled, not remounted.
    expect(rowForText(container, "Old text")).toBe(oldRow);
    expect(rowForText(container, "Old text")?.classList).not.toContain(
      "activity-enter",
    );
  });

  it("an in-place text edit flashes only the changed row", () => {
    const a = comment("c-a", "Alpha", "2026-10-13T10:00:00.000Z");
    const b = comment("c-b", "Beta", "2026-10-13T10:01:00.000Z");
    const { container, rerender } = renderFeed([a, b]);
    expect(container.querySelectorAll(".activity-flash")).toHaveLength(0);

    const bEdited = { ...b, text: "Beta edited" };
    rerender(
      <CommentsList
        comments={[a, bEdited]}
        loading={false}
        error={null}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const flashed = container.querySelectorAll(".activity-flash");
    expect(flashed).toHaveLength(1);
    expect(flashed[0].textContent).toContain("Beta edited");
    expect(rowForText(container, "Alpha")?.classList).not.toContain(
      "activity-flash",
    );
  });

  it("a removed row unmounts without flashing or entering its neighbours", () => {
    const a = comment("c-a", "Alpha", "2026-10-13T10:00:00.000Z");
    const b = comment("c-b", "Beta", "2026-10-13T10:01:00.000Z");
    const { container, rerender } = renderFeed([a, b]);
    const aRow = rowForText(container, "Alpha");

    rerender(
      <CommentsList
        comments={[b]}
        loading={false}
        error={null}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(rowForText(container, "Beta")).not.toBeNull();
    expect(rowForText(container, "Alpha")).toBeNull();
    // The surviving row kept its node (no remount blink on remove either).
    expect(
      container.querySelectorAll(".activity-enter, .activity-flash"),
    ).toHaveLength(0);
    void aRow;
  });
});

describe("prefers-reduced-motion is honored", () => {
  it("new rows render without the enter animation when reduced motion is preferred", () => {
    setReducedMotion(true);
    const old = comment("c-old", "Old text", "2026-10-13T10:00:00.000Z");
    const { container, rerender } = renderFeed([old]);
    rerender(
      <CommentsList
        comments={[old, comment("c-new", "New text", "2026-10-13T10:01:00.000Z")]}
        loading={false}
        error={null}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(rowForText(container, "New text")).not.toBeNull();
    expect(container.querySelectorAll(".activity-enter")).toHaveLength(0);
    setReducedMotion(false);
  });

  it("edits render without the flash when reduced motion is preferred", () => {
    setReducedMotion(true);
    const a = comment("c-a", "Alpha", "2026-10-13T10:00:00.000Z");
    const { container, rerender } = renderFeed([a]);
    rerender(
      <CommentsList
        comments={[{ ...a, text: "Alpha edited" }]}
        loading={false}
        error={null}
        onEdit={vi.fn().mockResolvedValue(undefined)}
        onDelete={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(rowForText(container, "Alpha edited")).not.toBeNull();
    expect(container.querySelectorAll(".activity-flash")).toHaveLength(0);
    setReducedMotion(false);
  });
});
