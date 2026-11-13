import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { Input } from "../input";

afterEach(cleanup);

const TYPES = ["text", "email", "password", "search", "number"] as const;

describe("Input (P10.2)", () => {
  it.each(TYPES)("renders type=%s and forwards it to the element", (type) => {
    render(<Input type={type} defaultValue="x" aria-label="probe" />);
    expect(screen.getByLabelText("probe")).toHaveAttribute("type", type);
  });

  it("forwards data-testid to the <input>, not a wrapper", () => {
    render(<Input data-testid="probe" aria-label="probe" />);
    const el = screen.getByTestId("probe");
    expect(el.tagName).toBe("INPUT");
  });

  it("fires onChange with the typed value", async () => {
    const onChange = vi.fn();
    render(<Input aria-label="probe" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("probe"), "hi");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls.at(-1)?.[0].target.value).toBe("hi");
  });

  it("does not change while disabled", async () => {
    const onChange = vi.fn();
    render(<Input aria-label="probe" disabled onChange={onChange} />);
    const el = screen.getByLabelText("probe");
    await userEvent.type(el, "hi");
    expect(onChange).not.toHaveBeenCalled();
    expect(el).toBeDisabled();
  });

  it("keeps the value visible but inert while read-only", async () => {
    const onChange = vi.fn();
    render(<Input aria-label="probe" readOnly value="fixed" onChange={onChange} />);
    const el = screen.getByLabelText("probe");
    await userEvent.type(el, "x");
    expect(onChange).not.toHaveBeenCalled();
    expect(el).toHaveValue("fixed");
  });

  it("wires the error contract: aria-invalid plus a resolvable described-by", () => {
    render(<Input id="email" aria-label="probe" error="Enter a valid address" />);
    const el = screen.getByLabelText("probe");
    expect(el).toHaveAttribute("aria-invalid", "true");
    const describedBy = el.getAttribute("aria-describedby");
    expect(describedBy).toBe("email-error");
    // The id must RESOLVE — an aria-describedby pointing at nothing is worse
    // than none at all, which is what this asserts.
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      "Enter a valid address",
    );
  });

  it("associates the error even when the caller supplies no id", () => {
    // Regression: `error && id` meant the documented contract was false for
    // every caller without an id — the message rendered but pointed at nothing.
    render(<Input aria-label="probe" error="Required" />);
    const el = screen.getByLabelText("probe");
    const describedBy = el.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent("Required");
    expect(el).toHaveAttribute("aria-invalid", "true");
  });

  it("renders only the input when there is no error (no surprise wrapper)", () => {
    const { container } = render(<Input aria-label="probe" />);
    expect(container.querySelector("div")).toBeNull();
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("uses token utilities only — no raw colour, no arbitrary value", () => {
    render(<Input aria-label="probe" error="boom" />);
    const cls = screen.getByLabelText("probe").className;
    expect(cls).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(cls).not.toMatch(/\[[^\]]+\]/);
    expect(cls).toMatch(/\bborder-danger\b/);
  });
});
