// @vitest-environment jsdom
/**
 * Description preview height is driven by ROWS, not a fixed px box (6656be8e).
 *
 * The description field's edit textarea rests at 6 rows and auto-grows to 12,
 * so the preview mirrors that range: `previewMinRows`/`previewMaxRows` convert
 * to px with the preview box's own typography (fontSize 12 × lineHeight 1.7 +
 * 2×10 padding + 2×1 border) → `rows * 20.4 + 22`:
 *
 *   6 rows  → 144.4px
 *   12 rows → 266.8px
 *
 * Without the rows props nothing changes: the px props (defaults 54/220, the
 * comments field's shape) still win, and the component never sets a width
 * style — width stays CSS/box-driven, never content-driven.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MarkdownEditableField } from "../shared/MarkdownEditableField";

type FieldProps = React.ComponentProps<typeof MarkdownEditableField>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPreview(props: Partial<FieldProps> = {}) {
  // The component indexes tasks for #mentions on mount. Never settle: these
  // tests never type '#', so no state update (and no act() warning) is wanted.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<never>(() => {})),
  );
  const view = render(
    <MarkdownEditableField
      value="Description text"
      onChange={vi.fn()}
      showPreview
      setShowPreview={vi.fn()}
      previewId="test-desc-preview"
      textareaId="test-desc"
      placeholder="Description (markdown)…"
      {...props}
    />,
  );
  const preview = document.getElementById("test-desc-preview");
  expect(preview).not.toBeNull();
  return { ...view, preview: preview as HTMLElement };
}

describe("MarkdownEditableField preview row range", () => {
  it("caps the preview at 12 rows (266.8px) with previewMaxRows={12}", () => {
    const { preview } = renderPreview({ previewMaxRows: 12 });
    expect(preview.style.maxHeight).toBe("266.8px");
  });

  it("floors the preview at 6 rows (144.4px) with previewMinRows={6}", () => {
    const { preview } = renderPreview({ previewMinRows: 6 });
    expect(preview.style.minHeight).toBe("144.4px");
  });

  it("keeps the default px bounds when no rows props are passed", () => {
    const { preview } = renderPreview();
    expect(preview.style.minHeight).toBe("54px");
    expect(preview.style.maxHeight).toBe("220px");
  });

  it("lets previewMaxRows take precedence over previewMaxHeight", () => {
    const { preview } = renderPreview({
      previewMaxRows: 12,
      previewMaxHeight: 999,
    });
    expect(preview.style.maxHeight).toBe("266.8px");
  });

  it("lets previewMinRows take precedence over previewMinHeight", () => {
    const { preview } = renderPreview({
      previewMinRows: 6,
      previewMinHeight: 999,
    });
    expect(preview.style.minHeight).toBe("144.4px");
  });

  it("never sets a width style on the preview root (width-invariance)", () => {
    const { preview } = renderPreview({
      previewMinRows: 6,
      previewMaxRows: 12,
    });
    expect(preview.style.width).toBe("");
  });

  it("never sets a width style on the preview root without rows props", () => {
    const { preview } = renderPreview();
    expect(preview.style.width).toBe("");
  });
});
