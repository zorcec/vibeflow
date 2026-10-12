// @vitest-environment jsdom
/**
 * Remote cursor overlay polish (multiplayer child 5).
 *
 * - One `[data-remote-cursor]` caret per peer, each in its own stable
 *   per-user colour (colours differ between peers).
 * - The peer-name flag carries a text-shadow so 9px white text stays legible
 *   on the lightest palette hues.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MarkdownEditableField } from "../shared/MarkdownEditableField";

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderEditor(
  remoteSelections: React.ComponentProps<
    typeof MarkdownEditableField
  >["remoteSelections"],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<never>(() => {})),
  );
  render(
    <MarkdownEditableField
      value="Hello collaborative world"
      onChange={vi.fn()}
      showPreview={false}
      setShowPreview={vi.fn()}
      previewId="test-desc-preview"
      textareaId="test-desc"
      placeholder="Description (markdown)…"
      remoteSelections={remoteSelections}
    />,
  );
}

describe("MarkdownEditableField remote cursors", () => {
  it("renders one caret per peer in distinct stable colours", () => {
    renderEditor([
      { key: "ana", name: "Ana", color: "hsl(0, 70%, 55%)", anchor: 0, head: 0 },
      { key: "ben", name: "Ben", color: "hsl(220, 70%, 55%)", anchor: 6, head: 6 },
    ]);
    const carets = document.querySelectorAll("[data-remote-cursor]");
    expect(carets).toHaveLength(2);
    const colors = [...carets].map(
      (el) => (el as HTMLElement).style.backgroundColor,
    );
    expect(new Set(colors).size).toBe(2);
    // Stability: the colour comes from the peer prop, unmodified by render
    // (compared through a reference so jsdom's hsl→rgb normalization matches).
    const ref = document.createElement("div");
    ref.style.backgroundColor = "hsl(0, 70%, 55%)";
    expect((carets[0] as HTMLElement).style.backgroundColor).toBe(
      ref.style.backgroundColor,
    );
    expect(carets[0]).toHaveAttribute("title", "Ana");
  });

  it("keeps the peer-name flag legible on the lightest hues", () => {
    renderEditor([
      // Lightest palette hue: white-on-yellow without a text-shadow is unreadable.
      { key: "cid", name: "Cid", color: "hsl(55, 70%, 55%)", anchor: 3, head: 3 },
    ]);
    const caret = document.querySelector(
      '[data-remote-cursor="cid"]',
    ) as HTMLElement;
    expect(caret).not.toBeNull();
    const flag = caret.firstElementChild as HTMLElement;
    expect(flag.style.textShadow).not.toBe("");
    expect(flag).toHaveTextContent("Cid");
  });

  it("renders no overlay without remote selections", () => {
    renderEditor([]);
    expect(
      document.querySelector("[data-remote-cursor]"),
    ).toBeNull();
  });
});
