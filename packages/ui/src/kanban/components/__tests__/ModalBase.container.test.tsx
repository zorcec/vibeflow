import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import React from "react";
import { ModalBase } from "../ModalBase";

/**
 * `container` is the overlay's isolation contract (P7): a modal portalled to
 * `document.body` escapes the shadow root, so it loses the overlay's tokens
 * and renders unstyled. This asserts the portal target is honoured — the
 * failure mode is silent (the modal still appears, just outside the root and
 * with the host page's styles).
 */
describe("ModalBase container (P14.1)", () => {
  it("portals the dialog into the given container instead of document.body", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    root.appendChild(mount);

    render(
      <ModalBase open onClose={vi.fn()} title="Shadow modal" container={mount}>
        <p>inside the shadow root</p>
      </ModalBase>,
    );

    const dialog = root.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog).toHaveTextContent("Shadow modal");
    // And it is NOT in the light DOM body — that is the whole point.
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    host.remove();
  });

  it("closes through onClose on Escape and does not confirm", () => {
    const onClose = vi.fn();
    render(
      <ModalBase open onClose={onClose} title="Escapable">
        <p>body</p>
      </ModalBase>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open when closeOnOutsideClick is false", () => {
    const onClose = vi.fn();
    render(
      <ModalBase
        open
        onClose={onClose}
        title="Sticky"
        closeOnOutsideClick={false}
      >
        <p>body</p>
      </ModalBase>,
    );
    const backdrop = document.body.querySelector(
      '[data-role="dialog-backdrop"]',
    );
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop as Element);
    fireEvent.click(backdrop as Element);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("ModalBase Escape (deep review)", () => {
  it("calls onClose once when Escape reaches both the popup and window", async () => {
    // Regression: Base UI's popup handler runs FIRST for a real keypress
    // (the event bubbles popup → window), so the old guard was consumed in
    // the opposite order and onClose ran twice for one key.
    const onClose = vi.fn();
    render(
      <ModalBase open onClose={onClose} title="Escape twice">
        <p>body</p>
      </ModalBase>,
    );

    const dialog = screen.getByRole("dialog");
    // Base UI's own path: a keydown on the focused element inside the popup.
    fireEvent.keyDown(dialog, { key: "Escape" });
    // Our window listener sees the same keypress.
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
