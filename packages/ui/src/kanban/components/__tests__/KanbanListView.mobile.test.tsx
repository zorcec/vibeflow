import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { KanbanListView } from "../KanbanListView";
import { resolveResponsiveView } from "../../viewState";
import type { Task } from "../../types";

/**
 * Status of this suite after the owner order of 2026-11-21 (ticket
 * 6e927e14908f0cc28c89106657b0bd): the board is the ONLY view at every width —
 * list and compact and the view toggle are gone product-wide, so
 * `resolveResponsiveView` resolves to board everywhere (pinned first below).
 * The component itself is retained (still exported; no host renders it), so
 * the guards below stay: they keep that retained `mobile` prop honest for any
 * surface that still mounts the component directly. The phone's move path is
 * the board card's coarse-pointer advance control (TaskCard.advance.test.tsx).
 */
const tasks: Task[] = [{ id: "done-1", title: "Done item", status: "done" }];
const props = {
  tasks,
  searchQuery: "",
  onOpenPanel: vi.fn(),
  onAddTask: vi.fn(),
  onDrop: vi.fn(),
  onChangeStatus: vi.fn(),
};

describe("KanbanListView mobile transitions", () => {
  it("is unreachable everywhere: every width resolves to the board", () => {
    // The contract that replaced the old saved-view/mobile-override model.
    // Everything below pins the component's retained `mobile` prop, which no
    // host can select anymore — this assertion is the one that says so.
    for (const width of [360, 390, 767, 768, 1280]) {
      expect(resolveResponsiveView("list", width)).toBe("board");
      expect(resolveResponsiveView("compact", width)).toBe("board");
    }
    // Even a stale session override cannot bring list back.
    expect(resolveResponsiveView("list", 390, "list")).toBe("board");
    expect(resolveResponsiveView("compact", 1280, "compact")).toBe("board");
  });

  it("collapses Done on desktop-to-mobile entry but preserves an in-session expansion", async () => {
    const view = render(<KanbanListView {...props} />);
    const toggle = view.getByRole("button", { name: "Collapse done" });
    fireEvent.click(toggle);
    expect(view.getByRole("button", { name: "Expand done" })).toBeTruthy();
    view.rerender(<KanbanListView {...props} mobile />);
    await waitFor(() => expect(view.getByRole("button", { name: "Expand done" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Expand done" }));
    view.rerender(<KanbanListView {...props} mobile={false} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Collapse done" })).toBeTruthy());
    view.rerender(<KanbanListView {...props} mobile />);
    await waitFor(() => expect(view.getByRole("button", { name: "Expand done" })).toBeTruthy());
  });

  it("offers a touch-accessible non-drag status control on mobile only", () => {
    const view = render(<KanbanListView {...props} mobile />);
    fireEvent.click(view.getByRole("button", { name: "Expand done" }));
    const status = view.getByRole("combobox", { name: "Change status for Done item" });
    fireEvent.change(status, { target: { value: "todo" } });
    expect(props.onChangeStatus).toHaveBeenCalledWith("done-1", "todo");
    view.rerender(<KanbanListView {...props} />);
    expect(view.queryByRole("combobox", { name: "Change status for Done item" })).toBeNull();
  });

  it("styles the mobile status select with theme tokens, not the UA default", () => {
    // Regression (ticket sgj3bggkhovwphrnq5gdmi26): the unstyled native select
    // painted the UA default rgb(239,239,239) on every theme — a white box on
    // dark boards. The select must carry --t-input/--t-text like other inputs.
    const view = render(<KanbanListView {...props} mobile />);
    fireEvent.click(view.getByRole("button", { name: "Expand done" }));
    const status = view.getByRole("combobox", {
      name: "Change status for Done item",
    });
    const inline = status.getAttribute("style") ?? "";
    expect(inline).toContain("var(--t-input)");
    expect(inline).toContain("var(--t-text)");
    expect(inline).not.toContain("239, 239, 239");
  });
});
