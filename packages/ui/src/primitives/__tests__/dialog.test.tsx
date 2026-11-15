import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { Dialog } from "../dialog";

afterEach(cleanup);

function renderDialog(props: Partial<Parameters<typeof Dialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const utils = render(
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Rename board"
      description="The new name is visible to every member."
      footer={<button type="button">Save</button>}
      {...props}
    >
      <p>Body</p>
    </Dialog>,
  );
  return { ...utils, onOpenChange };
}

describe("Dialog (P11.1)", () => {
  it("renders nothing when closed", () => {
    render(
      <Dialog open={false} onOpenChange={vi.fn()} title="Hidden">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("exposes an accessible name from the title and a description", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)).toHaveTextContent(
      "Rename board",
    );
    expect(document.getElementById(describedBy as string)).toHaveTextContent(
      "visible to every member",
    );
  });

  it("marks the popup as modal", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus into the dialog when it opens", async () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    // Base UI focuses the popup (or its first tabbable child) on open.
    await vi.waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it("closes on Escape", async () => {
    const { onOpenChange } = renderDialog();
    const dialog = screen.getByRole("dialog");
    // Focus must be inside before a keyboard user can press anything; waiting
    // for it also proves the focus-move half of the contract.
    await vi.waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    // Base UI's Escape handler listens at DOCUMENT level (measured: dispatching
    // on the popup does nothing, on document closes the dialog). jsdom has no
    // real key routing, so the document dispatch is the faithful equivalent of
    // the browser's own bubbling keydown.
    fireEvent.keyDown(document, { key: "Escape" });
    // Base UI calls back with (open, event); the open flag is the contract.
    expect(onOpenChange).toHaveBeenCalled();
    expect(onOpenChange.mock.calls.at(-1)?.[0]).toBe(false);
  });

  it("renders the footer only when given one", () => {
    const { unmount } = renderDialog();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    unmount();
    renderDialog({ footer: undefined });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("portals into the provided container — the overlay's shadow-root contract", () => {
    const host = document.createElement("div");
    host.setAttribute("data-testid", "shadow-host");
    document.body.appendChild(host);

    renderDialog({ container: host });
    const dialog = screen.getByRole("dialog");
    expect(host.contains(dialog), "dialog must live inside the given container").toBe(
      true,
    );
    host.remove();
  });

  it("keeps the default portal on document.body when no container is given", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(document.body.contains(dialog)).toBe(true);
  });

  it("uses token utilities only — no raw colour, no arbitrary value", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    expect(dialog.className).not.toMatch(/\[[^\]]+\]/);
    expect(dialog.className).toMatch(/\bbg-bg-raised\b/);
  });
});
