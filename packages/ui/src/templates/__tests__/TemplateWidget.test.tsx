// @vitest-environment jsdom
/**
 * Template widget test (design-system P8) — runs in the unit suite so the
 * template cannot rot: if `TemplateWidget.tsx` drifts, this fails. The
 * scaffold copies it beside each new component, where it doubles as the
 * coverage the scoped 90% gate requires over `src/components/**`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TemplateWidget } from "../TemplateWidget";

afterEach(cleanup);

describe("TemplateWidget", () => {
  it("renders the label with the quiet tone by default", () => {
    render(<TemplateWidget label="Hello" onAction={vi.fn()} />);
    const action = screen.getByTestId("TemplateWidget-action");
    expect(action).toHaveTextContent("Hello");
    expect(action.className).toContain("bg-bg");
  });

  it("resolves the loud tone and forwards the label on click", () => {
    const onAction = vi.fn();
    render(
      <TemplateWidget label="Loud hello" tone="loud" onAction={onAction} />,
    );
    const action = screen.getByTestId("TemplateWidget-action");
    expect(action.className).toContain("bg-accent-soft");
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledWith("Loud hello");
  });

  it("merges an extra className last", () => {
    render(
      <TemplateWidget
        label="Hi"
        onAction={vi.fn()}
        className="extra-class"
      />,
    );
    expect(screen.getByTestId("TemplateWidget-action").className).toContain(
      "extra-class",
    );
  });
});
