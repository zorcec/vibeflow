import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { VariantProvider } from "../src/context.js";
import { VariantSwitcher } from "../src/VariantSwitcher.js";

const variants = {
  default: {},
  minimal: {},
  detailed: {},
};

function TestApp({ defaultVisible = true }: { defaultVisible?: boolean }) {
  return (
    <VariantProvider defaultVisible={defaultVisible}>
      <div style={{ position: "relative" }}>
        <VariantSwitcher name="Card" variants={variants} />
        <span>card content</span>
      </div>
    </VariantProvider>
  );
}

describe("VariantSwitcher", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/"),
    });
  });

  it("renders the indicator dot by default", () => {
    render(<TestApp />);
    const dot = screen.getByRole("toolbar", { name: /Card/ });
    expect(dot).toBeInTheDocument();
    // The expand button should be visible
    const expandBtn = screen.getByRole("button", { name: /Open variant switcher/ });
    expect(expandBtn).toBeInTheDocument();
    // Numbered buttons should NOT be visible yet
    expect(screen.queryByRole("radio", { name: /1/ })).toBeNull();
  });

  it("clicking the dot expands the picker", () => {
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: /Open variant switcher/ }));
    // Now numbered buttons should appear
    expect(screen.getByRole("radio", { name: /1/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /2/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /3/ })).toBeInTheDocument();
  });

  it("first variant is active by default", () => {
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: /Open variant switcher/ }));
    expect(screen.getByRole("radio", { name: /1/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("clicking a variant selects it and collapses the picker", () => {
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: /Open variant switcher/ }));
    fireEvent.click(screen.getByRole("radio", { name: /2/ }));
    // Picker should collapse
    expect(screen.queryByRole("radio", { name: /1/ })).toBeNull();
    // Dot should be back
    expect(screen.getByRole("button", { name: /Open variant switcher/ })).toBeInTheDocument();
  });

  it("clicking outside collapses the picker", () => {
    render(
      <VariantProvider>
        <div style={{ position: "relative" }}>
          <VariantSwitcher name="Card" variants={variants} />
          <span>card content</span>
        </div>
        <span data-testid="outside">outside</span>
      </VariantProvider>,
    );
    // Expand
    fireEvent.click(screen.getByRole("button", { name: /Open variant switcher/ }));
    expect(screen.getByRole("radio", { name: /1/ })).toBeInTheDocument();
    // Click outside
    fireEvent.mouseDown(screen.getByTestId("outside"));
    // Should collapse
    expect(screen.queryByRole("radio", { name: /1/ })).toBeNull();
  });

  it("pressing Escape collapses the picker", () => {
    render(<TestApp />);
    fireEvent.click(screen.getByRole("button", { name: /Open variant switcher/ }));
    expect(screen.getByRole("radio", { name: /1/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("radio", { name: /1/ })).toBeNull();
  });

  it("is hidden when uiVisible is false", () => {
    render(<TestApp defaultVisible={false} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("does not render with only one variant", () => {
    render(
      <VariantProvider>
        <div style={{ position: "relative" }}>
          <VariantSwitcher name="Solo" variants={{ only: {} }} />
        </div>
      </VariantProvider>,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("position=left places switcher on the left", () => {
    render(
      <VariantProvider>
        <div style={{ position: "relative" }}>
          <VariantSwitcher name="L" variants={{ a: {}, b: {} }} position="left" />
        </div>
      </VariantProvider>,
    );
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.getAttribute("style")).toContain("left: -24px");
  });

  it("position=right (default) places switcher on the right", () => {
    render(
      <VariantProvider>
        <div style={{ position: "relative" }}>
          <VariantSwitcher name="R" variants={{ a: {}, b: {} }} />
        </div>
      </VariantProvider>,
    );
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.getAttribute("style")).toContain("right: -24px");
  });

  it("deduplicates switchers per scope — only first instance renders", () => {
    render(
      <VariantProvider>
        <div style={{ position: "relative" }}>
          <VariantSwitcher name="Shared" variants={variants} />
          <span>first</span>
        </div>
        <div style={{ position: "relative" }}>
          <VariantSwitcher name="Shared" variants={variants} />
          <span>second</span>
        </div>
      </VariantProvider>,
    );
    const toolbars = screen.getAllByRole("toolbar");
    expect(toolbars.length).toBe(1);
  });

  it("allows different scopes to each have their own switcher", () => {
    render(
      <VariantProvider>
        <div style={{ position: "relative" }}>
          <VariantSwitcher name="ScopeA" variants={variants} />
        </div>
        <div style={{ position: "relative" }}>
          <VariantSwitcher name="ScopeB" variants={variants} />
        </div>
      </VariantProvider>,
    );
    const toolbars = screen.getAllByRole("toolbar");
    expect(toolbars.length).toBe(2);
  });
});
