import React from "react";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard } from "../KanbanBoard";
import type { Task, TaskStatus } from "../../types";

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

function makeTask(id: string, title: string, status: TaskStatus): Task {
  return { id, title, status };
}

function renderBoard(
  tasks: Task[],
  columnFooter?: (status: TaskStatus) => React.ReactNode,
) {
  return render(
    <KanbanBoard
      tasks={tasks}
      visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={vi.fn()}
      columnFooter={columnFooter}
    />,
  );
}

describe("KanbanBoard columnFooter", () => {
  it("renders nothing extra when the prop is absent (other consumers unaffected)", () => {
    const { container } = renderBoard([
      makeTask("d1", "Done one", "done"),
      makeTask("t1", "Todo one", "todo"),
    ]);
    const scroll = container.querySelector(
      '[data-column-id="done"] .column-scroll',
    )!;
    expect(scroll).toBeInTheDocument();
    // Only the card wrapper — no footer node appended.
    expect(scroll.querySelector("[data-testid=\"done-column-footer\"]")).toBeNull();
    expect(scroll.children.length).toBe(1);
  });

  it("renders the footer LAST inside the done column scroll, after the cards", () => {
    const { container } = renderBoard(
      [
        makeTask("d1", "Done one", "done"),
        makeTask("d2", "Done two", "done"),
        makeTask("t1", "Todo one", "todo"),
      ],
      (status) =>
        status === "done" ? (
          <span data-testid="done-column-footer">2 done</span>
        ) : null,
    );
    const scroll = container.querySelector(
      '[data-column-id="done"] .column-scroll',
    )!;
    const footer = scroll.querySelector(
      '[data-testid="done-column-footer"]',
    )!;
    expect(footer).toBeInTheDocument();
    expect(footer).toHaveTextContent("2 done");
    // LAST child of the scroll content — after every card.
    expect(scroll.lastElementChild).toBe(footer);
  });

  it("does not render the footer in columns the callback returns null for", () => {
    const { container } = renderBoard(
      [
        makeTask("d1", "Done one", "done"),
        makeTask("t1", "Todo one", "todo"),
      ],
      (status) =>
        status === "done" ? (
          <span data-testid="done-column-footer">1 done</span>
        ) : null,
    );
    const todoScroll = container.querySelector(
      '[data-column-id="todo"] .column-scroll',
    )!;
    expect(
      todoScroll.querySelector('[data-testid="done-column-footer"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="done-column-footer"]'),
    ).toHaveLength(1);
  });
});
