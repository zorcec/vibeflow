import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { KanbanListView } from "../KanbanListView";
import type { Task } from "../../types";

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
