// @vitest-environment jsdom
/**
 * SettingsModal board tab — the fullscreen checkbox is GONE
 * (ticket 04dbd2df0e2ab8e60643b175f3730c).
 *
 * The "Open task details fullscreen" checkbox (`#settings-panel-fullscreen`)
 * was removed from the settings modal. The `panelFullscreen` preference itself
 * stays alive: the detail panel's own maximize/restore control
 * (`#dp-fullscreen-toggle`) owns that flag, and the modal's save payload
 * omits the key so App.tsx's `{ ...appSettings, ...newSettings }` merge
 * preserves a previously saved value instead of clobbering it.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SettingsModal } from "../SettingsModal";

function renderModal(settings: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(
    <SettingsModal
      open
      visibleCols={["todo", "in-progress", "review"]}
      settings={settings}
      onClose={onClose}
      onSave={onSave}
    />,
  );
  return { onSave, onClose };
}

describe("settings fullscreen checkbox removed (04dbd2df0e2ab8e60643b175f3730c)", () => {
  it("renders no fullscreen checkbox, even with a saved panelFullscreen:true", () => {
    renderModal({ panelFullscreen: true });
    expect(
      screen.queryByLabelText("Open task details fullscreen"),
    ).toBeNull();
    expect(
      screen.queryByText("Open task details fullscreen"),
    ).toBeNull();
    expect(
      document.getElementById("settings-panel-fullscreen"),
    ).toBeNull();
  });

  it("renders no fullscreen checkbox with default settings either", () => {
    renderModal();
    expect(
      screen.queryByLabelText("Open task details fullscreen"),
    ).toBeNull();
    expect(
      document.getElementById("settings-panel-fullscreen"),
    ).toBeNull();
  });

  it("Apply omits panelFullscreen so a saved true is preserved by the caller merge", () => {
    const { onSave } = renderModal({ panelFullscreen: true });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("panelFullscreen");
    // App.tsx merges `{ ...appSettings, ...newSettings }`: omitting the key
    // keeps the previously saved value instead of clobbering it.
    const merged = { panelFullscreen: true, ...payload };
    expect(merged.panelFullscreen).toBe(true);
  });

  it("Apply still forwards the remaining workflow flags", () => {
    const { onSave } = renderModal({});
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSave.mock.calls[0][1]).toMatchObject({
      autoCommit: false,
      autoComment: false,
      autoPush: false,
      createBranch: false,
      requireVerifyBeforeReview: false,
    });
  });
});
