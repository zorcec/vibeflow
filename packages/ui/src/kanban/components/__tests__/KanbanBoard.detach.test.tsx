import React from "react";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard } from "../KanbanBoard";
import type { Task } from "../../types";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const parent: Task = { id: "p1", title: "Parent", status: "todo" };
const child: Task = {
  id: "c1",
  title: "Child",
  status: "todo",
  links: [{ type: "parent", taskId: "p1" }],
};

function renderBoard(tasks: Task[], onDetach?: (taskId: string) => void) {
  return render(
    <KanbanBoard
      tasks={tasks}
      visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={vi.fn()}
      onDetach={onDetach}
    />,
  );
}

describe("KanbanBoard onDetach (ticket ppydm810)", () => {
  it("wires the card inline tree Unlink button to onDetach with the child id", () => {
    const onDetach = vi.fn();
    const { getByRole } = renderBoard([parent, child], onDetach);
    const unlink = getByRole("button", {
      name: "Unlink child task Child from parent",
    });
    fireEvent.click(unlink);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledWith("c1");
  });

  it("renders no Unlink button when onDetach is absent (other consumers unaffected)", () => {
    const { queryByRole } = renderBoard([parent, child]);
    expect(
      queryByRole("button", {
        name: "Unlink child task Child from parent",
      }),
    ).toBeNull();
  });
});
