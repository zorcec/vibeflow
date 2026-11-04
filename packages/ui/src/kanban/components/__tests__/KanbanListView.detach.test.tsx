import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanListView } from "../KanbanListView";
import type { Task } from "../../types";

// A child whose parent is NOT in the filtered set renders as a standalone
// row WITH its parent link intact (groupTasksByRoot orphan fallback) — the
// only list surface where an Unlink action applies.
const orphanChild: Task = {
  id: "c1",
  title: "Orphan child",
  status: "todo",
  links: [{ type: "parent", taskId: "missing-parent" }],
};
const root: Task = { id: "p1", title: "Root", status: "todo" };

function renderList(tasks: Task[], onDetach?: (taskId: string) => void) {
  return render(
    <KanbanListView
      tasks={tasks}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onAddTask={vi.fn()}
      onDrop={vi.fn()}
      onDetach={onDetach}
    />,
  );
}

describe("KanbanListView onDetach (ticket ppydm810)", () => {
  it("unlinks the row's own id when its Unlink action is clicked", () => {
    const onDetach = vi.fn();
    const { getByRole } = renderList([root, orphanChild], onDetach);
    const unlink = getByRole("button", {
      name: "Unlink task Orphan child from parent",
    });
    fireEvent.click(unlink);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledWith("c1");
  });

  it("renders no Unlink action on parentless rows", () => {
    const onDetach = vi.fn();
    const { queryByRole } = renderList([root], onDetach);
    expect(
      queryByRole("button", { name: /Unlink task .* from parent/ }),
    ).toBeNull();
  });

  it("renders no Unlink action when onDetach is absent (other consumers unaffected)", () => {
    const { queryByRole } = renderList([root, orphanChild]);
    expect(
      queryByRole("button", { name: /Unlink task .* from parent/ }),
    ).toBeNull();
  });
});
