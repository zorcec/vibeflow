import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { VariantProvider } from "../src/context.js";
import { VariantSwitcher, _resetStylesInjected } from "../src/VariantSwitcher.js";

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
    _resetStylesInjected();
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/"),
    });
  });

  it("renders the toolbar with numbered buttons", () => {
    render(<TestApp />);
    const toolbar = screen.getByRole("toolbar", { name: /Card/ });
    expect(toolbar).toBeInTheDocument();
    // Numbered: 1, 2, 3
    expect(screen.getByRole("radio", { name: /1/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /2/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /3/ })).toBeInTheDocument();
  });

  it("first variant is active by default", () => {
    render(<TestApp />);
    expect(screen.getByRole("radio", { name: /1/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("clicking button 2 activates the second variant", () => {
    render(<TestApp />);
    // Use fireEvent because the switcher uses pointer-events:none by default (CSS hover shows it)
    fireEvent.click(screen.getByRole("radio", { name: /2/ }));
    expect(screen.getByRole("radio", { name: /2/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /1/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
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

  it("injects CSS hover styles into document.head", () => {
    render(<TestApp />);
    const styleTag = document.head.querySelector("[data-vf-switcher]");
    expect(styleTag).not.toBeNull();
    expect(styleTag?.textContent).toContain("vf-variant-switcher");
  });

  it("does not inject CSS styles twice (singleton)", () => {
    render(<TestApp />);
    render(<TestApp />);
    const styleTags = document.head.querySelectorAll("[data-vf-switcher]");
    // After reset in beforeEach + two renders, should be exactly 1
    expect(styleTags.length).toBe(1);
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
    // left: -28px should be in inline style
    expect(toolbar.getAttribute("style")).toContain("left: -28px");
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
    expect(toolbar.getAttribute("style")).toContain("right: -28px");
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
