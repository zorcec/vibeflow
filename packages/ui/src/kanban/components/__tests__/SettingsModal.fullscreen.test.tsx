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
