import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { Popover } from "../popover";

afterEach(cleanup);

function renderPopover(props: Partial<Parameters<typeof Popover>[0]> = {}) {
  const onOpenChange = vi.fn();
  const utils = render(
    <Popover
      open={false}
      onOpenChange={onOpenChange}
      trigger={<button type="button">Open</button>}
      {...props}
    >
      <p>Popover body</p>
    </Popover>,
  );
  return { ...utils, onOpenChange };
}

describe("Popover (P11.2)", () => {
  it("renders only the trigger when closed", () => {
    renderPopover();
    expect(screen.getByRole("button")).toBeInTheDocument();
    expect(screen.queryByText("Popover body")).toBeNull();
  });

  it("requests opening on trigger click, exactly once", async () => {
    const { onOpenChange } = renderPopover();
    await userEvent.click(screen.getByRole("button"));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(true);
  });

  it("renders its content when open", () => {
    renderPopover({ open: true });
    expect(screen.getByText("Popover body")).toBeInTheDocument();
  });

  it("closes on Escape, exactly once", () => {
    const { onOpenChange } = renderPopover({ open: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  it("closes on outside click", async () => {
    const { onOpenChange } = renderPopover({ open: true });
    await userEvent.click(document.body);
    expect(onOpenChange.mock.calls.at(-1)?.[0]).toBe(false);
  });

  it("portals into the given container — the overlay's shadow-root contract", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    renderPopover({ open: true, container: host });
    const popup = document.querySelector('[data-role="popover-popup"]');
    expect(popup).not.toBeNull();
    expect(host.contains(popup as Node)).toBe(true);
    host.remove();
  });

  it("defaults its portal to document.body", () => {
    renderPopover({ open: true });
    const popup = document.querySelector('[data-role="popover-popup"]');
    expect(document.body.contains(popup as Node)).toBe(true);
  });

  it("uses token utilities only — no raw colour, no arbitrary value", () => {
    renderPopover({ open: true });
    const popup = document.querySelector('[data-role="popover-popup"]') as HTMLElement;
    expect(popup.className).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(popup.className).not.toMatch(/\[[^\]]+\]/);
    expect(popup.className).toMatch(/\bbg-bg-raised\b/);
  });
});
