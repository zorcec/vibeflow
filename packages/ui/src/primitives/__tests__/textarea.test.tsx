import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { Textarea } from "../textarea";

afterEach(cleanup);

describe("Textarea (P10.2)", () => {
  it("renders the requested number of rows", () => {
    render(<Textarea aria-label="probe" rows={5} />);
    expect(screen.getByLabelText("probe")).toHaveAttribute("rows", "5");
  });

  it("forwards data-testid to the <textarea>", () => {
    render(<Textarea data-testid="probe" aria-label="probe" />);
    expect(screen.getByTestId("probe").tagName).toBe("TEXTAREA");
  });

  it("fires onChange with the typed value", async () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="probe" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("probe"), "ok");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("blocks input while disabled", async () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="probe" disabled onChange={onChange} />);
    const el = screen.getByLabelText("probe");
    await userEvent.type(el, "no");
    expect(onChange).not.toHaveBeenCalled();
    expect(el).toBeDisabled();
  });

  it("wires the error contract like Input does", () => {
    render(<Textarea id="notes" aria-label="probe" error="Too long" />);
    const el = screen.getByLabelText("probe");
    expect(el).toHaveAttribute("aria-invalid", "true");
    const describedBy = el.getAttribute("aria-describedby");
    expect(describedBy).toBe("notes-error");
    expect(document.getElementById(describedBy as string)).toHaveTextContent("Too long");
  });

  it("autoExpand grows the box with the content instead of scrolling", async () => {
    render(<Textarea aria-label="probe" autoExpand />);
    const el = screen.getByLabelText("probe") as HTMLTextAreaElement;

    // jsdom does not lay out, so scrollHeight is 0 for everyone. Stand in for
    // the browser: derive scrollHeight from the text so this asserts OUR logic
    // (set height to auto, then to scrollHeight) rather than jsdom's constant.
    let height = "0px";
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => 24 + (el.value.split("\n").length - 1) * 20,
    });
    Object.defineProperty(el.style, "height", {
      configurable: true,
      get: () => height,
      set: (v: string) => {
        height = v;
      },
    });

    await userEvent.type(el, "one{enter}two{enter}three");
    // 3 lines ⇒ 24 + 2*20 = 64px, and the height must have been reset to auto
    // before measuring (otherwise the box can only ever grow).
    expect(el.style.height).toBe("64px");
  });

  it("autoExpand is off by default, so the resize handle is the user's", () => {
    render(<Textarea aria-label="probe" />);
    expect(screen.getByLabelText("probe").className).toMatch(/\bresize-y\b/);
  });

  it("associates the error even when the caller supplies no id", () => {
    render(<Textarea aria-label="probe" error="Required" />);
    const el = screen.getByLabelText("probe");
    const describedBy = el.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent("Required");
  });

  it("uses token utilities only", () => {
    render(<Textarea aria-label="probe" error="boom" />);
    const cls = screen.getByLabelText("probe").className;
    expect(cls).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(cls).not.toMatch(/\[[^\]]+\]/);
    expect(cls).toMatch(/\bborder-danger\b/);
  });
});
