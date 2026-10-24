// @vitest-environment jsdom
/**
 * SettingsModal live-prop tab stability (ticket xpm4z3n3 — "sometimes I have
 * to click twice").
 *
 * The tab-sync effect used to reset `activeTab` on EVERY
 * `[open, visibleCols, settings]` change: click Board, a settings/columns
 * update lands while the dialog stays open, the pane snaps back to
 * Enforcement, and the next click "works" once props settle. The reset now
 * runs only on a genuine closed→open transition; the form-field sync still
 * follows every prop change.
 *
 * Non-vacuity: written against the fixed code, then the guard was reverted
 * (`setActiveTab` unconditional) and both tab assertions failed — restored.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsModal } from "../SettingsModal";

function tabButton(label: string): HTMLElement {
  const button = screen
    .getAllByRole("button")
    .find((el) => el.textContent === label);
  if (!button) throw new Error(`No tab button labelled "${label}"`);
  return button;
}

describe("SettingsModal keeps the selected tab across live prop updates", () => {
  it("stays on Board when settings/columns identities change while open", () => {
    const { rerender } = render(
      <SettingsModal
        open
        visibleCols={["todo", "in-progress", "review"]}
        settings={{}}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(tabButton("Board"));
    expect(screen.getByText("Visible Columns")).toBeInTheDocument();

    // A live update: new object identities, dialog never closed.
    rerender(
      <SettingsModal
        open
        visibleCols={["todo", "in-progress"]}
        settings={{ autoCommit: true }}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    // Still on Board — and the form sync still followed the new props
    // (Review column unchecked), so the fix only gated the tab reset.
    expect(screen.getByText("Visible Columns")).toBeInTheDocument();
    expect(
      document.getElementById("settings-col-review") as HTMLInputElement,
    ).not.toBeChecked();
  });

  it("still opens on Enforcement after a close→reopen cycle", () => {
    const { rerender } = render(
      <SettingsModal
        open
        visibleCols={["todo", "in-progress", "review"]}
        settings={{}}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(tabButton("Board"));
    expect(screen.getByText("Visible Columns")).toBeInTheDocument();

    rerender(
      <SettingsModal
        open={false}
        visibleCols={["todo", "in-progress", "review"]}
        settings={{}}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    rerender(
      <SettingsModal
        open
        visibleCols={["todo", "in-progress", "review"]}
        settings={{}}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Require a verification verdict before review"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Visible Columns")).toBeNull();
  });
});
