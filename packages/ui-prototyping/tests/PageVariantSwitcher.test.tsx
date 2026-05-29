import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { VariantProvider } from "../src/context.js";
import { PageVariantSwitcher } from "../src/PageVariantSwitcher.js";

const variants = {
  columns: {},
  swimlane: {},
  compact: {},
};

function TestApp({
  defaultVisible = true,
}: {
  defaultVisible?: boolean;
}) {
  return (
    <VariantProvider defaultVisible={defaultVisible}>
      <PageVariantSwitcher name="Layout" variants={variants} />
    </VariantProvider>
  );
}

describe("PageVariantSwitcher", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/"),
    });
  });

  it("renders the toolbar with variant buttons", () => {
    render(<TestApp />);
    expect(screen.getByRole("toolbar", { name: /Layout/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /columns/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /swimlane/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /compact/ })).toBeInTheDocument();
  });

  it("first variant is active by default", () => {
    render(<TestApp />);
    const columnsBtn = screen.getByRole("radio", { name: /columns/ });
    expect(columnsBtn).toHaveAttribute("aria-checked", "true");
  });

  it("clicking a variant marks it as active", async () => {
    const user = userEvent.setup();
    render(<TestApp />);
    const swimlaneBtn = screen.getByRole("radio", { name: /swimlane/ });
    await user.click(swimlaneBtn);
    expect(swimlaneBtn).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /columns/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("is hidden when uiVisible is false", () => {
    render(<TestApp defaultVisible={false} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("does not render when only one variant exists", () => {
    render(
      <VariantProvider>
        <PageVariantSwitcher name="Solo" variants={{ only: {} }} />
      </VariantProvider>,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("uses localStorage variant as initial active", () => {
    localStorage.setItem("__vf__Layout", "compact");
    render(<TestApp />);
    expect(screen.getByRole("radio", { name: /compact/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("uses URL variant as initial active (priority over localStorage)", () => {
    localStorage.setItem("__vf__Layout", "columns");
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("http://localhost/?vf%5BLayout%5D=swimlane"),
    });
    render(<TestApp />);
    expect(screen.getByRole("radio", { name: /swimlane/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
