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
import type { AppearanceSlotHandle } from "../SettingsModal";

function renderModal(
  props: Partial<React.ComponentProps<typeof SettingsModal>> = {},
) {
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

/** Fake slot content: proves the modal's lifecycle is theme-agnostic. */
function SlotSpy({
  slot,
  onUndo,
  onCommit,
}: {
  slot: AppearanceSlotHandle;
  onUndo: () => void;
  onCommit: () => void;
}) {
  React.useEffect(() => {
    slot.registerUndo(onUndo);
    slot.registerCommit(onCommit);
  }, [slot, onUndo, onCommit]);
  return <div data-testid="appearance-slot">slot</div>;
}

describe("SettingsModal appearance slot lifecycle", () => {
  it("rewinds a render-function slot on Cancel and never commits", () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    renderModal({
      appearance: (slot) => (
        <SlotSpy slot={slot} onUndo={onUndo} onCommit={onCommit} />
      ),
      appearanceTab: { label: "Theme" },
    });
    fireEvent.click(tabButton("Theme"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits a render-function slot on Apply and does not rewind", () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    renderModal({
      appearance: (slot) => (
        <SlotSpy slot={slot} onUndo={onUndo} onCommit={onCommit} />
      ),
      appearanceTab: { label: "Theme" },
    });
    fireEvent.click(tabButton("Theme"));
    fireEvent.click(screen.getByText("Apply"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("hands the slot a fresh session on every open", () => {
    const sessions: AppearanceSlotHandle["state"][] = [];
    const modal = (open: boolean) => (
      <SettingsModal
        open={open}
        visibleCols={["todo"]}
        settings={{}}
        onClose={vi.fn()}
        onSave={vi.fn()}
        appearance={(slot) => {
          sessions.push(slot.state);
          return <div />;
        }}
      />
    );
    const { rerender } = render(modal(true));
    const firstSession = sessions[sessions.length - 1];
    rerender(modal(false));
    rerender(modal(true));
    expect(sessions[sessions.length - 1]).not.toBe(firstSession);
  });
});
