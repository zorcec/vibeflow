// @vitest-environment jsdom
/**
 * File-operation activity icons (65ea2a68).
 *
 * The server stores file add/remove traces as system comments with an emoji
 * prefix (`📎 File added: `name`` / `🗑️ File removed: `name``). The activity
 * feed must render a lucide action icon instead of the emoji — Paperclip for
 * an addition, Trash2 for a removal — sized to the other activity glyphs,
 * labelled for screen readers, with the human text intact (minus the emoji).
 *
 * The mapping keys off the fixed action prefix on a `type: 'system'`
 * comment, never off the filename that follows it: a trace for ANY filename
 * (including `weird-📎-name.webp`) gets its icon from the action, and an
 * ordinary comment that merely mentions a filename gets no icon.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  CommentsList,
  fileActivityAction,
  stripFileTraceEmoji,
} from "../shared/CommentsList";
import type { Comment } from "../../types";

function systemComment(text: string): Comment {
  return {
    id: `sys-${text.length}-${text.slice(0, 8)}`,
    author: "user",
    text,
    createdAt: "2026-10-13T14:46:43.000Z",
    type: "system",
  };
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

describe("file activity action detection", () => {
  it("maps the stored emoji-prefixed traces to their action", () => {
    expect(
      fileActivityAction("📎 File added: `paste-2026-10-13T14-46-43.webp`"),
    ).toBe("added");
    expect(
      fileActivityAction("🗑️ File removed: `paste-2026-10-13T14-46-43.webp`"),
    ).toBe("removed");
  });

  it("maps bare action-prefixed traces (no emoji) the same way", () => {
    expect(fileActivityAction("File added: `a.png`")).toBe("added");
    expect(fileActivityAction("File removed: `a.png`")).toBe("removed");
  });

  it("ignores the filename: emoji inside the name never decides the icon", () => {
    expect(fileActivityAction("📎 File added: `weird-📎-🗑️-name.webp`")).toBe(
      "added",
    );
    expect(fileActivityAction("🗑️ File removed: `📎-bait.png`")).toBe(
      "removed",
    );
  });

  it("returns null for ordinary system text", () => {
    expect(fileActivityAction("Task edited")).toBeNull();
    expect(fileActivityAction("📎 just an emoji plus words")).toBeNull();
    expect(fileActivityAction("")).toBeNull();
  });

  it("strips only the leading emoji prefix, keeping the human text", () => {
    expect(stripFileTraceEmoji("🗑️ File removed: `x.webp`")).toBe(
      "File removed: `x.webp`",
    );
    expect(stripFileTraceEmoji("File added: `x.webp`")).toBe(
      "File added: `x.webp`",
    );
  });
});

describe("file activity rows render lucide action icons", () => {
  it("a removal trace renders the Trash2 icon with a File removed label", () => {
    const text = "🗑️ File removed: `paste-2026-10-13T14-46-43.webp`";
    const { container } = renderFeed([systemComment(text)]);
    const icon = container.querySelector(".lucide-trash2");
    // Non-vacuous: without the icon mapping this query finds nothing.
    expect(icon).not.toBeNull();
    const labelled = icon!.closest('[aria-label="File removed"]');
    expect(labelled).not.toBeNull();
    expect(labelled?.getAttribute("title")).toBe("File removed");
    // Human text intact (minus the emoji): filename still asserted by name.
    expect(container.textContent).toContain(
      "File removed: `paste-2026-10-13T14-46-43.webp`",
    );
    expect(container.textContent).not.toContain("🗑️");
    // The generic system marker must not double up beside the icon.
    expect(container.textContent).not.toContain("⬡");
  });

  it("an addition trace renders the Paperclip icon with a File added label", () => {
    const text = "📎 File added: `paste-2026-10-13T14-46-43.webp`";
    const { container } = renderFeed([systemComment(text)]);
    const icon = container.querySelector(".lucide-paperclip");
    expect(icon).not.toBeNull();
    expect(icon!.closest('[aria-label="File added"]')).not.toBeNull();
    expect(container.textContent).toContain(
      "File added: `paste-2026-10-13T14-46-43.webp`",
    );
    expect(container.textContent).not.toContain("📎");
    expect(container.textContent).not.toContain("⬡");
  });

  it("an ordinary system comment keeps the generic marker and gains no icon", () => {
    const { container } = renderFeed([systemComment("Task edited")]);
    expect(container.textContent).toContain("⬡");
    expect(container.textContent).toContain("Task edited");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("a normal user comment mentioning a filename gains no file icon", () => {
    const { container } = renderFeed([
      {
        id: "u1",
        author: "user",
        text: "please check paste-2026-10-13T14-46-43.webp",
        createdAt: "2026-10-13T14:46:43.000Z",
      },
    ]);
    expect(
      container.querySelector(".lucide-paperclip, .lucide-trash2"),
    ).toBeNull();
  });
});
