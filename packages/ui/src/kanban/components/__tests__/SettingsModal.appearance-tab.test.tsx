// @vitest-environment jsdom
/**
 * SettingsModal appearance tab.
 *
 * The shared modal stays appearance-agnostic: the `appearance` slot is surfaced
 * as its own tab only when a surface supplies it, and the tab is named by that
 * surface via `appearanceTab` (defaulting to a generic "Appearance" label).
 * This locks the contract that other consumers keep the original two tabs and
 * never mount appearance UI they did not ask for.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsModal } from "../SettingsModal";

function renderModal(props: Partial<React.ComponentProps<typeof SettingsModal>> = {}) {
  return render(
    <SettingsModal
      open
      visibleCols={["todo", "in-progress", "review"]}
      settings={{}}
      onClose={vi.fn()}
      onSave={vi.fn()}
      {...props}
    />,
  );
}

function tabButton(label: string): HTMLElement {
  const button = screen
    .getAllByRole("button")
    .find((el) => el.textContent === label);
  if (!button) throw new Error(`No tab button labelled "${label}"`);
  return button;
}

describe("SettingsModal tabs", () => {
  it("shows only Board and Enforcement when no appearance slot is supplied", () => {
    renderModal();
    expect(screen.getByText("Board")).toBeInTheDocument();
    expect(screen.getByText("Enforcement")).toBeInTheDocument();
    expect(screen.queryByText("Theme")).toBeNull();
    expect(screen.queryByText("Appearance")).toBeNull();
  });

  it("gives the appearance slot its own tab, named by appearanceTab", () => {
    renderModal({
      appearance: <div data-testid="appearance-slot">theme-control</div>,
      appearanceTab: { label: "Theme" },
    });

    // Board is the landing tab, so the slot is not mounted yet.
    expect(screen.queryByTestId("appearance-slot")).toBeNull();

    fireEvent.click(tabButton("Theme"));
    expect(screen.getByTestId("appearance-slot")).toBeInTheDocument();

    // Leaving the tab hides the slot again.
    fireEvent.click(tabButton("Board"));
    expect(screen.queryByTestId("appearance-slot")).toBeNull();
  });

  it("falls back to a generic Appearance label when appearanceTab is omitted", () => {
    renderModal({
      appearance: <div data-testid="appearance-slot">theme-control</div>,
    });
    fireEvent.click(tabButton("Appearance"));
    expect(screen.getByTestId("appearance-slot")).toBeInTheDocument();
  });
});
