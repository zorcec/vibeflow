// @vitest-environment jsdom
/**
 * Minimal field entries in the activity feed (3647a4715eeebe2a2ce02571a58c91).
 *
 * One save reads as ONE small row naming the field. Long/structural values
 * (description text, link sets) would be a diff dump, so those rows render
 * name-only; short fields keep the established from→to pills. Tags name the
 * actual added/removed tags instead (59f91dc0ce2978a19c191afd06e640).
 *
 * Non-vacuity: the name-only cases fail on the old code, where every change
 * row rendered pills; the tag-detail cases fail on the pre-59f91dc0 code,
 * where tags rows rendered name-only; the pill case fails if the convention
 * regresses.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommentsList, type LocalChange } from "../shared/CommentsList";

function renderFeed(
  changes: LocalChange[] = [],
  stamps: { createdAt?: string; updatedAt?: string } = {},
) {
  return render(
    <CommentsList
      comments={[]}
      localChanges={changes}
      loading={false}
      error={null}
      taskCreatedAt={stamps.createdAt}
      taskUpdatedAt={stamps.updatedAt}
      onEdit={vi.fn().mockResolvedValue(undefined)}
      onDelete={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

function change(overrides: Partial<LocalChange> = {}): LocalChange {
  return {
    field: "description",
    from: "old text",
    to: "new text",
    actor: "Ada",
    timestamp: "2026-10-16T10:00:00.000Z",
    ...overrides,
  };
}

describe("minimal field entries", () => {
  it("renders a description edit as a name-only row (no value pills)", () => {
    const { container } = renderFeed([change({ field: "description" })]);
    expect(container.textContent).toContain("changed");
    expect(container.textContent).toContain("description");
    expect(container.textContent).not.toContain("old text");
    expect(container.textContent).not.toContain("new text");
    expect(container.textContent).not.toContain("→");
  });

  it("renders relations edits as name-only rows", () => {
    const { container } = renderFeed([
      change({
        field: "relations",
        from: "",
        to: "parent:abc",
        timestamp: "2026-10-16T10:00:01.000Z",
      }),
    ]);
    expect(container.textContent).toContain("relations");
    expect(container.textContent).not.toContain("parent:abc");
    expect(container.textContent).not.toContain("→");
  });

  it("names the single tag added (59f91dc0)", () => {
    const { container } = renderFeed([
      change({
        field: "tags",
        from: "a",
        to: "a,b",
        added: ["b"],
        removed: [],
      }),
    ]);
    expect(container.textContent).toContain("changed");
    expect(container.textContent).toContain("tags");
    expect(container.textContent).toContain("added: b");
    expect(container.textContent).not.toContain("removed:");
    expect(container.textContent).not.toContain("→");
  });

  it("names several added and removed tags at once (59f91dc0)", () => {
    const { container } = renderFeed([
      change({
        field: "tags",
        from: "bug,p1",
        to: "bug,ui,ux",
        added: ["ui", "ux"],
        removed: ["p1"],
      }),
    ]);
    expect(container.textContent).toContain("added: ui, ux");
    expect(container.textContent).toContain("removed: p1");
    expect(container.textContent).not.toContain("→");
  });

  it("derives the diff from stored keys on pre-fix tag rows (59f91dc0)", () => {
    // Rows recorded before the write path carried added/removed still name
    // the diff — derived from the stored from/to keys, never invented.
    const { container } = renderFeed([
      change({ field: "tags", from: "a", to: "a,b" }),
    ]);
    expect(container.textContent).toContain("added: b");
  });

  it("keeps the from→to pills for short fields (established convention)", () => {
    const { container } = renderFeed([
      change({ field: "title", from: "Old", to: "New" }),
      change({
        field: "priority",
        from: "Medium",
        to: "High",
        timestamp: "2026-10-16T10:00:01.000Z",
      }),
    ]);
    expect(container.textContent).toContain("Old");
    expect(container.textContent).toContain("New");
    expect(container.textContent).toContain("Medium");
    expect(container.textContent).toContain("High");
  });

  it("reads one description save as exactly one entry (no double-count)", () => {
    // b27cf2b2: counts are EVENTS. One save already yields the generic
    // timestamp-derived "Task edited" row; the field entry must add
    // exactly ONE more row — never two rows for the same field change.
    const { container } = renderFeed(
      [change({ field: "description" })],
      {
        createdAt: "2026-10-16T09:00:00.000Z",
        updatedAt: "2026-10-16T10:00:00.000Z",
      },
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Task edited");
    expect(text.match(/changed description/g)).toHaveLength(1);
    expect(text).not.toContain("new text");
  });

  it("still shows the actor on a minimal row", () => {
    const { container } = renderFeed([change({ actor: "🤖 Agent" })]);
    // Agent marker carries its own glyph — no second 👤 prefix (9314e404).
    expect(container.textContent).toContain("🤖 Agent");
    expect(container.textContent).not.toContain("👤 🤖 Agent");
  });
});
