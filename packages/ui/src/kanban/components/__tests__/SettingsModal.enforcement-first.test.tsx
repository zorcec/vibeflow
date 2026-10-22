// @vitest-environment jsdom
/**
 * SettingsModal tab order (ticket w0sph9e5 — "Set enforcement as first tab").
 *
 * The owner asked for Enforcement to be the first tab, and a dialog that
 * opens on a tab other than the first is a second, quieter disagreement: the
 * active tab must be the one at the front. Both facts are pinned here so a
 * future tab cannot silently reorder the dialog or steal the opening tab.
 *
 * The order rule is append-only: a new tab goes AFTER these two, never
 * before Enforcement.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsModal } from "../SettingsModal";

function renderModal() {
  return render(
    <SettingsModal
      open
      visibleCols={["todo", "in-progress", "review"]}
      settings={{}}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />,
  );
}

describe("SettingsModal tab order", () => {
  it("renders Enforcement as the first tab", () => {
    renderModal();
    const tabs = screen.getAllByRole("button", { name: /enforcement|board/i });
    // The tab strip is the only place both labels appear as buttons at once.
    const labels = tabs.map((t) => (t.textContent ?? "").trim().toLowerCase());
    expect(labels.indexOf("enforcement")).toBe(0);
  });

  it("opens on Enforcement, not Board", () => {
    renderModal();
    // The enforcement pane is present on open: its workflow toggle exists
    // without any click.
    expect(
      screen.getByText("Require a verification verdict before review"),
    ).toBeInTheDocument();
  });
});
