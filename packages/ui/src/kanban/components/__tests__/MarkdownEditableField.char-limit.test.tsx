// @vitest-environment jsdom
/**
 * Near-limit description counter (description-limit unification).
 *
 * The editor stays silent in the normal case: the `N / 20,000` counter
 * appears only in the last 2,000 chars (>= 18,000) and turns amber in the
 * last 500 (>= 19,500). `maxLength` on the textarea makes over-limit
 * submission by typing/pasting impossible.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MarkdownEditableField } from "../shared/MarkdownEditableField";
import { TASK_DESCRIPTION_MAX } from "@vibeflow-tools/shared";

type FieldProps = React.ComponentProps<typeof MarkdownEditableField>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderEditor(
  value: string,
  props: Partial<FieldProps> = {},
) {
  // Same never-settling fetch stub as the rows tests: the #mention index
  // must not resolve mid-render (no act() noise; these tests never type #).
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<never>(() => {})),
  );
  return render(
    <MarkdownEditableField
      value={value}
      onChange={vi.fn()}
      showPreview={false}
      setShowPreview={vi.fn()}
      previewId="test-desc-preview"
      textareaId="test-desc"
      placeholder="Description (markdown)…"
      charLimit={TASK_DESCRIPTION_MAX}
      {...props}
    />,
  );
}

describe("description near-limit counter", () => {
  it("stays hidden below 18,000 chars", () => {
    const { queryByTestId } = renderEditor("x".repeat(17_999));
    expect(queryByTestId("desc-char-count")).toBeNull();
  });

  it("appears at 18,000 chars formatted as `18,000 / 20,000`", () => {
    const { getByTestId } = renderEditor("x".repeat(18_000));
    const counter = getByTestId("desc-char-count");
    expect(counter).toHaveTextContent("18,000 / 20,000");
    expect(counter.style.color).not.toBe("var(--t-warning)");
  });

  it("turns amber at 19,500 chars", () => {
    const { getByTestId } = renderEditor("x".repeat(19_500));
    const counter = getByTestId("desc-char-count");
    expect(counter).toHaveTextContent("19,500 / 20,000");
    expect(counter.style.color).toBe("var(--t-warning)");
  });

  it("caps the textarea at the limit so over-limit submit is impossible", () => {
    const { container } = renderEditor("short");
    const textarea = container.querySelector("textarea");
    expect(textarea?.getAttribute("maxlength")).toBe(
      String(TASK_DESCRIPTION_MAX),
    );
  });

  it("renders no counter and no maxlength without charLimit (comments)", () => {
    const { queryByTestId, container } = renderEditor("x".repeat(19_999), {
      charLimit: undefined,
    });
    expect(queryByTestId("desc-char-count")).toBeNull();
    expect(
      container.querySelector("textarea")?.getAttribute("maxlength"),
    ).toBeNull();
  });
});
