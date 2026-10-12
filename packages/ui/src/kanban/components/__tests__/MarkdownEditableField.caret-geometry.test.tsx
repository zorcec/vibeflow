// @vitest-environment jsdom
/**
 * Remote-caret geometry + flag contract (vibeflow task 67af5d5b).
 *
 * Settled from the owner's screenshot: the 2px caret is fine — the ugly
 * element is the NAME FLAG, a ~73px solid rounded box spelling the peer's
 * full name ("Tomislav Zorčec") above the caret, covering the line above
 * the text. The flag now shows the peer's INITIALS (via `presenceInitials`,
 * the same helper as the presence chips) in a compact 8px/12px label that
 * hugs the caret, while the full name stays discoverable via `title` (sighted
 * hover) and `aria-label` (screen readers — the text-duplicating mirrors
 * stay `aria-hidden` so the doc is never read twice).
 *
 * - caret width is exactly 2px (never a percentage or doc-sized block);
 * - caret height tracks the *textarea's own computed line-height*
 *   (stubbed to an unmistakable 32px: a hardcoded or percentage height
 *   fails this test);
 * - the flag renders INITIALS, never the full name as visible text;
 * - the flag stays 8px/12px (never the doc font size) and hugs the caret:
 *   2px above it, or directly below it when there is no room above
 *   (jsdom lays out no boxes, so every marker measures top 0 and takes
 *   the below-caret branch — the first-line case);
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

function renderEditorWithLineHeight(
  lineHeight: string,
  name = "Tomislav Zorčec",
) {
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
          key: "tom",
          name,
          color: "hsl(55, 70%, 55%)",
          anchor: 6,
          head: 6,
        },
      ]}
    />,
  );
  return document.querySelector('[data-remote-cursor="tom"]') as HTMLElement;
}

describe("MarkdownEditableField remote-caret geometry", () => {
  it("renders a 2px caret at exactly the doc line-height", () => {
    const caret = renderEditorWithLineHeight("32px");
    expect(caret).not.toBeNull();
    expect(caret.style.width).toBe("2px");
    expect(caret.style.height).toBe("32px");
  });

  it("renders peer INITIALS in the flag, never the full name as visible text", () => {
    const caret = renderEditorWithLineHeight("32px", "Tomislav Zorčec");
    const flag = caret.firstElementChild as HTMLElement;
    expect(flag).toHaveTextContent("TZ");
    expect(flag.textContent).not.toContain("Tomislav");
  });

  it("uses the first two letters for single-name peers, as the presence chips do", () => {
    const caret = renderEditorWithLineHeight("32px", "Ana");
    expect(caret.firstElementChild as HTMLElement).toHaveTextContent(
      "AN",
    );
  });

  it("keeps the full name discoverable via title and screen-reader label", () => {
    const caret = renderEditorWithLineHeight("32px", "Tomislav Zorčec");
    expect(caret).toHaveAttribute("title", "Tomislav Zorčec");
    const flag = caret.firstElementChild as HTMLElement;
    expect(flag).toHaveAttribute("role", "img");
    expect(flag).toHaveAttribute("aria-label", "Tomislav Zorčec");
  });

  it("keeps the flag small and hugging the caret", () => {
    const caret = renderEditorWithLineHeight("32px", "Tomislav Zorčec");
    const flag = caret.firstElementChild as HTMLElement;
    expect(flag.style.fontSize).toBe("8px");
    expect(flag.style.lineHeight).toBe("12px");
    // jsdom measures every marker at top 0 (no layout), so the caret takes
    // the first-line branch: the flag hangs directly below it — top edge at
    // caret height + the 2px hug gap, i.e. attached, never floating.
    expect(flag.style.top).toBe("34px");
    expect(flag.style.left).toBe("-2px");
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
    const flag = caret.firstElementChild as HTMLElement;
    expect(flag.style.position).toBe("absolute");
  });

  it("hides the text-duplicating mirrors from assistive tech, not the flags", () => {
    const caret = renderEditorWithLineHeight("19.2px");
    const overlay = caret.parentElement as HTMLElement;
    expect(overlay).not.toHaveAttribute("aria-hidden");
    const mirrors = Array.from(overlay.children).filter((el) =>
      el.className.includes("dp-textarea"),
    );
    expect(mirrors.length).toBeGreaterThan(0);
    for (const mirror of mirrors) {
      expect(mirror).toHaveAttribute("aria-hidden", "true");
    }
  });
});
