// @vitest-environment jsdom
/**
 * Remote-caret geometry contract (vibeflow task 67af5d5b).
 *
 * Finding: the owner's "very large cursor" does not reproduce from this
 * source. Measured in headless Chromium at DPR 1 against the real
 * stylesheet (12px monospace, 19.2px line box), the caret is a 2px-wide
 * line at exactly the doc line-height with a 9px name flag — i.e. the
 * familiar collaborative caret the ticket asks for. The only large
 * element the overlay can paint is the *selection* tint (a peer with a
 * range selected, e.g. select-all, covers the doc in 0.3-opacity peer
 * colour) — a product call the owner has to make, so this lane changes
 * no pixels here. These tests pin the slim-caret contract so a future
 * "large cursor" regresses loudly instead of by screenshot:
 *
 * - caret width is exactly 2px (never a percentage or doc-sized block);
 * - caret height tracks the *textarea's own computed line-height*
 *   (stubbed to an unmistakable 32px: a hardcoded or percentage height
 *   fails this test);
 * - the name flag stays at 9px/14px (never the doc font size);
 * - overlay, mirrors, carets and flags are all absolutely positioned —
 *   the overlay contributes zero in-flow boxes, so remote peers can
 *   never shift the local layout.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MarkdownEditableField } from "../shared/MarkdownEditableField";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderEditorWithLineHeight(lineHeight: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<never>(() => {})),
  );
  // Distinctive metrics: if the caret tracked anything but the textarea's
  // own computed line-height, the height assertion below cannot pass.
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (() => ({
      lineHeight,
      fontSize: "16px",
      paddingTop: "8px",
      paddingBottom: "8px",
      borderTopWidth: "1px",
      borderBottomWidth: "1px",
      getPropertyValue: () => "",
    })) as unknown as typeof window.getComputedStyle,
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
      remoteSelections={[
        {
          key: "ana",
          name: "Ana",
          color: "hsl(0, 70%, 55%)",
          anchor: 6,
          head: 6,
        },
      ]}
    />,
  );
  return document.querySelector('[data-remote-cursor="ana"]') as HTMLElement;
}

describe("MarkdownEditableField remote-caret geometry", () => {
  it("renders a 2px caret at exactly the doc line-height", () => {
    const caret = renderEditorWithLineHeight("32px");
    expect(caret).not.toBeNull();
    expect(caret.style.width).toBe("2px");
    expect(caret.style.height).toBe("32px");
  });

  it("keeps the name flag small regardless of doc metrics", () => {
    const caret = renderEditorWithLineHeight("32px");
    const flag = caret.firstElementChild as HTMLElement;
    expect(flag.style.fontSize).toBe("9px");
    expect(flag.style.lineHeight).toBe("14px");
    expect(flag).toHaveTextContent("Ana");
  });

  it("positions the overlay and its boxes absolutely so peers never shift layout", () => {
    const caret = renderEditorWithLineHeight("19.2px");
    const overlay = caret.parentElement as HTMLElement;
    expect(overlay.style.position).toBe("absolute");
    // Direct boxes only (mirrors + carets): text runs *inside* the
    // absolute mirrors are inert by construction — the mirror itself is
    // out of flow, so nothing it contains can move the page.
    const boxes = Array.from(overlay.children) as HTMLElement[];
    expect(boxes.length).toBeGreaterThan(0);
    for (const el of boxes) {
      expect(el.style.position).toBe("absolute");
    }
  });
});
