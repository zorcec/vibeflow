// @vitest-environment jsdom
/**
 * SettingsModal board tab — the fullscreen checkbox
 * (`#settings-panel-fullscreen`, ticket cba0ade6).
 *
 * The checkbox mirrors the `#dp-fullscreen-toggle` header button: both write
 * the same `panelFullscreen` flag through the same `onSave` path, so the
 * preference can be set without opening a task.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsModal } from "../SettingsModal";

function renderModal(settings: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  render(
    <SettingsModal
      open
      visibleCols={["todo", "in-progress", "review"]}
      settings={settings}
      onClose={vi.fn()}
      onSave={onSave}
    />,
  );
  return { onSave };
}

describe("settings fullscreen checkbox (cba0ade6)", () => {
  it("is unchecked by default and reflects settings.panelFullscreen", () => {
    renderModal();
    expect(
      screen.getByLabelText("Open task details fullscreen"),
    ).not.toBeChecked();
    // Board tab is the default tab — no navigation needed.
  });

  it("reflects a persisted true value", () => {
    renderModal({ panelFullscreen: true });
    expect(screen.getByLabelText("Open task details fullscreen")).toBeChecked();
  });

  it("Apply forwards the toggled flag in onSave", () => {
    const { onSave } = renderModal({});
    fireEvent.click(screen.getByLabelText("Open task details fullscreen"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][1]).toMatchObject({ panelFullscreen: true });
  });

  it("unchecking a persisted true forwards false", () => {
    const { onSave } = renderModal({ panelFullscreen: true });
    fireEvent.click(screen.getByLabelText("Open task details fullscreen"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSave.mock.calls[0][1]).toMatchObject({ panelFullscreen: false });
  });
});

describe("settings fullscreen checkbox styling (2f6fddbf)", () => {
  /** The fullscreen checkbox, by its own id. */
  function fullscreenCheckbox(): HTMLElement {
    return document.getElementById("settings-panel-fullscreen")!;
  }

  /**
   * Element siblings a `dp-meta-label` heading owns — everything after it up
   * to the next heading. The board tab is one flex column whose sections are
   * delimited by headings, so this reads the real section, not a guessed
   * wrapper element.
   */
  function sectionOf(headingText: string): Element[] {
    const heading = screen.getByText(headingText);
    const section: Element[] = [];
    for (
      let node = heading.nextElementSibling;
      node && !node.classList.contains("dp-meta-label");
      node = node.nextElementSibling
    ) {
      section.push(node);
    }
    return section;
  }

  it("uses the design-token accent instead of the OS default", () => {
    renderModal();
    // Every other checkbox in the modal sets an accent (the column ones use
    // the column colour, DeleteConfirmDialog uses var(--t-accent)); leaving
    // `accent-color` unset is what rendered this one in the OS default blue.
    expect(fullscreenCheckbox().getAttribute("style")).toContain(
      "accent-color: var(--t-accent)",
    );
  });

  it("keeps the 14px size and pointer cursor shared with the column checkboxes", () => {
    renderModal();
    const style = fullscreenCheckbox().getAttribute("style") ?? "";
    expect(style).toContain("width: 14px");
    expect(style).toContain("height: 14px");
    expect(style).toContain("cursor: pointer");
  });

  it("renders in its own Display section, outside Visible Columns", () => {
    renderModal();
    const fullscreen = screen.getByLabelText("Open task details fullscreen");

    // The column section must not absorb the fullscreen checkbox any more:
    // five column rows, none of them the fullscreen toggle.
    const columnSection = sectionOf("Visible Columns");
    expect(columnSection).toHaveLength(5);
    expect(columnSection.some((el) => el.contains(fullscreen))).toBe(false);

    // ...and it gets its own heading, owning exactly the one fullscreen row.
    const displaySection = sectionOf("Display");
    expect(displaySection).toHaveLength(1);
    expect(displaySection[0]).toContain(fullscreen);
  });
});
