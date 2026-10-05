// @vitest-environment jsdom
/**
 * JSX comment leak — vibeflow task fb876c20 ("Weird error on task details").
 *
 * Two lines of explanation sat as the first CHILDREN of the fragment the
 * component returns:
 *
 *     return (
 *       <>
 *         // `data-role` mirrors the id so specs can address the panel ...
 *         // they address every other region of the board.
 *         <aside id="detail-panel" ...>
 *
 * Inside JSX, `//` is not a comment. The children of an element are text, so
 * both lines were rendered as literal visible copy above the panel header —
 * which is exactly what the screenshot on the ticket shows.
 *
 * This is easy to reintroduce and invisible in review, because the note looks
 * correct and the build is clean. So the guard is on the RENDERED output, not
 * on the source: no text node in the panel may start a line with `//`, and no
 * text node may mention `data-role`. A developer comment must never be
 * user-visible.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DetailPanel } from "../DetailPanel";
import type { Task } from "../../types";

const task: Task = {
  id: "t1",
  title: "Freemium infrastructure",
  status: "in-progress",
  type: "Task",
  priority: "Medium",
  description: "Architecture finalized: Neon free tier for 0-50 freemium users.",
  tags: [],
  comments: [],
  files: [],
  links: [],
  createdAt: new Date("2026-01-01T00:00:00Z"),
} as unknown as Task;

function renderPanel() {
  return render(
    <DetailPanel
      open
      task={task}
      tab="details"
      baseUrl="http://localhost:3700"
      api={
        {
          loadComments: vi.fn().mockResolvedValue([]),
          loadFiles: vi.fn().mockResolvedValue([]),
          loadBadgeCounts: vi.fn().mockResolvedValue({ comments: 0, files: 0 }),
        } as unknown as React.ComponentProps<typeof DetailPanel>["api"]
      }
      onClose={vi.fn()}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onPatch={vi.fn()}
      onFilePreview={vi.fn()}
    />,
  );
}

describe("DetailPanel renders no source comments", () => {
  it("shows no text node that looks like a line comment", () => {
    const { container } = renderPanel();
    expect(
      container.querySelector("#detail-panel"),
      "detail panel should render",
    ).not.toBeNull();

    // Scan the WHOLE render output, NOT #detail-panel.
    //
    // The leak renders as a sibling BEFORE the <aside>, inside the fragment the
    // component returns — it is not a descendant of the panel, which is why it
    // appears above the header in the screenshot. A first version of this test
    // scoped itself to #detail-panel and therefore passed with the bug still in
    // place: it was walking a subtree the leaked text is not in.
    const texts: string[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const t = (node.textContent ?? "").trim();
      if (t) texts.push(t);
      node = walker.nextNode();
    }

    const leaked = texts.filter(
      (t) =>
        /^\/\//.test(t) || // a line comment
        /^\/\*/.test(t) || // a block comment
        /\bdata-role\b/.test(t) || // this specific note
        /\breturn \(/.test(t),
    );
    expect(
      leaked,
      `developer comments leaked into the panel: ${JSON.stringify(leaked)}`,
    ).toEqual([]);
  });

  it("does not render the note from fb876c20 anywhere in the output", () => {
    const { container } = renderPanel();
    const text = container.textContent ?? "";
    expect(text).not.toContain("mirrors the id");
    expect(text).not.toContain("every other region of the board");
  });

  it("still renders the real header content", () => {
    // Guards against "fixing" the leak by deleting the panel.
    const { container } = renderPanel();
    const panel = container.querySelector("#detail-panel")!;
    expect(panel.getAttribute("data-role")).toBe("detail-panel");

    // The title is an editable <input>, so its text lives in `value` — it is
    // NOT part of textContent. Asserting textContent for it fails even on a
    // perfectly correct panel.
    const titleInput = panel.querySelector<HTMLInputElement>(
      'input[value="Freemium infrastructure"]',
    );
    expect(titleInput, "title input should carry the task title").not.toBeNull();

    // And the description body really is present as text.
    expect(panel.textContent ?? "").toContain("Neon free tier");
  });
});