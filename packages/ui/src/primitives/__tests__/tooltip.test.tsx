import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { Tooltip } from "../tooltip";

afterEach(cleanup);

describe("Tooltip (P11.2)", () => {
  it("renders no popup until the trigger is hovered or focused", () => {
    render(
      <Tooltip content="Saves the board" delay={0}>
        <button type="button">Save</button>
      </Tooltip>,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on hover", async () => {
    render(
      <Tooltip content="Saves the board" delay={0}>
        <button type="button">Save</button>
      </Tooltip>,
    );
    await userEvent.hover(screen.getByRole("button"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Saves the board");
  });

  it("shows on KEYBOARD focus — the half everyone forgets", async () => {
    render(
      <Tooltip content="Saves the board" delay={0}>
        <button type="button">Save</button>
      </Tooltip>,
    );
    // Tab-focused, not hovered: a keyboard user must get the same hint.
    (screen.getByRole("button") as HTMLElement).focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Saves the board");
  });

  it("wires aria-describedby from the trigger to the tooltip", async () => {
    render(
      <Tooltip content="Saves the board" delay={0}>
        <button type="button">Save</button>
      </Tooltip>,
    );
    (screen.getByRole("button") as HTMLElement).focus();
    const tooltip = await screen.findByRole("tooltip");
    const trigger = screen.getByRole("button");
    const ids = (trigger.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    expect(ids).toContain(tooltip.id);
    expect(document.getElementById(tooltip.id)).toBe(tooltip);
  });

  it("hides on blur", async () => {
    render(
      <Tooltip content="Saves the board" delay={0}>
        <button type="button">Save</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button") as HTMLElement;
    trigger.focus();
    await screen.findByRole("tooltip");
    trigger.blur();
    await expect.poll(() => screen.queryByRole("tooltip")).toBeNull();
  });

  it("renders no tooltip for a disabled trigger, and says so in the DOM", () => {
    // A disabled control cannot take focus, so a tooltip on it is unreachable
    // for keyboard users — the primitive renders the trigger alone instead.
    render(
      <Tooltip content="Cannot use this" disabled>
        <button type="button" disabled>
          Save
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button");
    expect(trigger).toBeDisabled();
    expect(trigger).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.querySelector('[data-role="tooltip-trigger"]')).toBeNull();
  });

  it("portals into the given container", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      <Tooltip content="Saves the board" delay={0} container={host}>
        <button type="button">Save</button>
      </Tooltip>,
    );
    (screen.getByRole("button") as HTMLElement).focus();
    const tooltip = await screen.findByRole("tooltip");
    expect(host.contains(tooltip)).toBe(true);
    host.remove();
  });

  it("uses token utilities only", async () => {
    render(
      <Tooltip content="Saves the board" delay={0}>
        <button type="button">Save</button>
      </Tooltip>,
    );
    (screen.getByRole("button") as HTMLElement).focus();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.className).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(tooltip.className).not.toMatch(/\[[^\]]+\]/);
  });
});

describe("Tooltip trigger composition (P11.2)", () => {
  it("keeps the caller's own handlers working", async () => {
    const onFocus = vi.fn();
    const onPointerEnter = vi.fn();
    render(
      <Tooltip content="Hint" delay={0}>
        <button type="button" onFocus={onFocus} onPointerEnter={onPointerEnter}>
          Save
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button") as HTMLElement;
    trigger.focus();
    expect(onFocus).toHaveBeenCalledTimes(1);
    await screen.findByRole("tooltip");
  });

  it("keeps the caller's own leave/blur handlers working", async () => {
    const onBlur = vi.fn();
    const onPointerLeave = vi.fn();
    render(
      <Tooltip content="Hint" delay={0}>
        <button type="button" onBlur={onBlur} onPointerLeave={onPointerLeave}>
          Save
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button") as HTMLElement;
    trigger.focus();
    await screen.findByRole("tooltip");
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    trigger.blur();
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
    expect(onBlur).toHaveBeenCalledTimes(1);
    await expect.poll(() => screen.queryByRole("tooltip")).toBeNull();
  });

  it("cancels a pending hover open when the pointer leaves first", async () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip content="Hint" delay={500}>
          <button type="button">Save</button>
        </Tooltip>,
      );
      const trigger = screen.getByRole("button");
      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
      fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
      vi.advanceTimersByTime(600);
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("Tooltip contract guard (P11.2)", () => {
  it("refuses a non-element child with a clear message", () => {
    // Base UI needs a single element to attach the trigger props to; a string
    // would silently produce a tooltip nobody can focus.
    expect(() =>
      render(<Tooltip content="Hint">just text</Tooltip>),
    ).toThrow(/single element/);
  });
});
