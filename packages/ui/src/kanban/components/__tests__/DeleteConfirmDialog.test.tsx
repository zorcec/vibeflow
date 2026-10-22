// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DeleteConfirmDialog } from "../DeleteConfirmDialog";

afterEach(cleanup);

/**
 * Ticket a46ba984 — board delete modal: block Cancel during the request.
 *
 * Once the delete request is in flight Cancel is disabled, the confirm
 * button shows a progress state, and Escape/backdrop clicks are ignored —
 * a half-cancelled delete is worse than either outcome. On failure the
 * host clears `loading` and passes `error`: Cancel re-enables and the
 * error is shown.
 */
function renderDialog(props?: {
  loading?: boolean;
  error?: string;
  onCancel?: () => void;
  onDelete?: (mode: "roots" | "recursive") => void;
}) {
  return render(
    <DeleteConfirmDialog
      open
      taskTitle="Parent task"
      childCount={2}
      onCancel={props?.onCancel ?? vi.fn()}
      onDelete={props?.onDelete ?? vi.fn()}
      loading={props?.loading}
      error={props?.error}
    />,
  );
}

describe("DeleteConfirmDialog in-flight guard (a46ba984)", () => {
  it("enables Cancel and calls onCancel on Escape at rest", () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking Delete forwards the chosen mode", () => {
    const onDelete = vi.fn();
    renderDialog({ onDelete });
    fireEvent.click(screen.getByRole("radio", { name: /whole subtree/i }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("recursive");
  });

  it("in flight: disables Cancel, shows progress, ignores Escape and backdrop", () => {
    const onCancel = vi.fn();
    const { container } = renderDialog({ loading: true, onCancel });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    const confirm = screen.getByRole("button", { name: "Deleting…" });
    expect(confirm).toBeDisabled();
    expect(confirm.querySelector("svg")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();

    const backdrop = container.ownerDocument.body.querySelector(
      "#delete-confirm-dialog",
    )!;
    fireEvent.click(backdrop);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("on failure: re-enables Cancel and shows the error", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <DeleteConfirmDialog
        open
        taskTitle="Parent task"
        childCount={2}
        onCancel={onCancel}
        onDelete={vi.fn()}
        loading
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    rerender(
      <DeleteConfirmDialog
        open
        taskTitle="Parent task"
        childCount={2}
        onCancel={onCancel}
        onDelete={vi.fn()}
        loading={false}
        error="Delete failed: network error"
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Delete failed: network error",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
