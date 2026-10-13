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
 * - the flag stays 8px/12px (never the doc font size) and always hugs
 *   from above (bottom 100% + 2px gap) — never hung below into text;
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

  it("keeps the flag small and hugging the caret from above", () => {
    const caret = renderEditorWithLineHeight("32px", "Tomislav Zorčec");
    const flag = caret.firstElementChild as HTMLElement;
    expect(flag.style.fontSize).toBe("8px");
    expect(flag.style.lineHeight).toBe("12px");
    // Always above (tab-style): bottom edge at the caret top + the 2px hug
    // gap — never hung below into the next line's text (67af5d5b round 2).
    expect(flag.style.bottom).toBe("100%");
    expect(flag.style.marginBottom).toBe("2px");
    expect(flag.style.top).toBe("");
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
    // Mirrors live in the clipped mirror layer (one level down since the
    // caret layer split); the layer itself carries the aria-hidden.
    const layer = overlay.querySelector("div[aria-hidden='true']");
    expect(layer).not.toBeNull();
    expect((layer as HTMLElement).style.overflow).toBe("hidden");
    const mirrors = Array.from(
      overlay.querySelectorAll(".dp-textarea"),
    );
    expect(mirrors.length).toBeGreaterThan(0);
    for (const mirror of mirrors) {
      expect(mirror.closest("[aria-hidden='true']")).not.toBeNull();
    }
  });

  it("anchors markers to the line-box top so carets span the line", () => {
    renderEditorWithLineHeight("32px");
    // The 0×0 marker must be top-aligned: baseline-aligned it measures the
    // baseline and the caret hangs a full line-height below the glyphs.
    const marker = document.querySelector(
      ".dp-textarea i",
    ) as HTMLElement;
    expect(marker).not.toBeNull();
    expect(marker.style.verticalAlign).toBe("top");
  });
});
