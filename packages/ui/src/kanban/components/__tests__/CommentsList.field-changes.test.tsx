// @vitest-environment jsdom
/**
 * Minimal field entries in the activity feed (3647a4715eeebe2a2ce02571a58c91).
 *
 * One save reads as ONE small row naming the field. Long/structural values
 * (description text, tag sets, link sets) would be a diff dump, so those
 * rows render name-only; short fields keep the established from→to pills.
 *
 * Non-vacuity: the name-only cases fail on the old code, where every change
 * row rendered pills; the pill case fails if the convention regresses.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { CommentsList, type LocalChange } from "../shared/CommentsList";

function renderFeed(changes: LocalChange[] = []) {
  return render(
    <CommentsList
      comments={[]}
      localChanges={changes}
      loading={false}
      error={null}
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

  it("renders tags and relations edits as name-only rows", () => {
    const { container } = renderFeed([
      change({ field: "tags", from: "a", to: "a,b" }),
      change({
        field: "relations",
        from: "",
        to: "parent:abc",
        timestamp: "2026-10-16T10:00:01.000Z",
      }),
    ]);
    expect(container.textContent).toContain("tags");
    expect(container.textContent).toContain("relations");
    expect(container.textContent).not.toContain("parent:abc");
    expect(container.textContent).not.toContain("→");
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

  it("still shows the actor on a minimal row", () => {
    const { container } = renderFeed([change({ actor: "🤖 Agent" })]);
    // Agent marker carries its own glyph — no second 👤 prefix (9314e404).
    expect(container.textContent).toContain("🤖 Agent");
    expect(container.textContent).not.toContain("👤 🤖 Agent");
  });
});
