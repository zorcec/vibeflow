import React from "react";
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard } from "../KanbanBoard";
import { dragSession } from "../../task-links";
import type { Task, TaskStatus } from "../../types";

// jsdom has no ResizeObserver — the board's fit-to-screen effect needs one.
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

function makeTask(id: string, title: string, status: TaskStatus): Task {
  return { id, title, status };
}

function dataTransfer() {
  return {
    setData: vi.fn(),
    getData: vi.fn(() => ""),
    effectAllowed: "none",
  };
}

/** Board wired to a shell that applies status drops, so a drop into done
 *  visibly moves the card — not just a spy. */
function Harness({
  initial,
  onDrop,
}: {
  initial: Task[];
  onDrop?: (taskId: string, status: TaskStatus) => void;
}) {
  const [tasks, setTasks] = React.useState(initial);
  return (
    <KanbanBoard
      tasks={tasks}
      visibleCols={["todo", "done"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={(taskId, status) => {
        onDrop?.(taskId, status);
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? { ...t, status } : t)),
        );
      }}
      onReorder={vi.fn()}
      onLinkChild={vi.fn()}
      onTreeReparent={vi.fn()}
    />
  );
}

function card(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(
    `article[data-task-id="${id}"]`,
  ) as HTMLElement;
}

function doneColumn(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-column-id="done"]') as HTMLElement;
}

function doneHint(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-done-drop-hint]");
}

function doneCards(container: HTMLElement): HTMLElement[] {
  return [...doneColumn(container).querySelectorAll<HTMLElement>("article[data-task-id]")];
}

/** The drag-source visuals land one macrotask after dragstart. */
async function flushDragStart() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("KanbanBoard done-lane drop hint (43f03542)", () => {
  afterEach(() => {
    dragSession.end();
  });

  it("shows done cards and no hint before any drag (non-vacuous baseline)", () => {
    const { container } = render(
      <Harness
        initial={[
          makeTask("t1", "Todo item", "todo"),
          makeTask("d1", "Done one", "done"),
          makeTask("d2", "Done two", "done"),
        ]}
      />,
    );

    expect(doneCards(container).map((c) => c.dataset.taskId).sort()).toEqual([
      "d1",
      "d2",
    ]);
    expect(doneHint(container)).toBeNull();
  });

  it("hides done cards and shows the hint DURING a drag", async () => {
    const { container } = render(
      <Harness
        initial={[
          makeTask("t1", "Todo item", "todo"),
          makeTask("d1", "Done one", "done"),
          makeTask("d2", "Done two", "done"),
        ]}
      />,
    );

    fireEvent.dragStart(card(container, "t1"), {
      dataTransfer: dataTransfer(),
    });
    await flushDragStart();

    // Cards gone from the done lane…
    expect(doneCards(container)).toEqual([]);
    // …hint visible instead.
    const hint = doneHint(container);
    expect(hint).not.toBeNull();
    expect(hint).toHaveTextContent("Drop here to mark as done");
    expect(hint).toHaveAttribute("role", "status");
  });

  it("a drop into done (onto the hint itself) moves the item and restores the lane", async () => {
    const onDrop = vi.fn();
    const { container } = render(
      <Harness
        initial={[
          makeTask("t1", "Todo item", "todo"),
          makeTask("d1", "Done one", "done"),
        ]}
        onDrop={onDrop}
      />,
    );

    fireEvent.dragStart(card(container, "t1"), {
      dataTransfer: dataTransfer(),
    });
    await flushDragStart();
    const hint = doneHint(container);
    expect(hint).not.toBeNull();

    // Hover the done column so the column intent is live, then drop
    // directly ONTO the hint box — the hint must itself be a valid target.
    fireEvent.dragOver(doneColumn(container));
    fireEvent.drop(hint!);

    // The item actually moved to done…
    expect(onDrop).toHaveBeenCalledWith("t1", "done");
    expect(
      card(container, "t1")
        .closest("[data-column-id]")
        ?.getAttribute("data-column-id"),
    ).toBe("done");
    // …and the lane is back to normal: cards visible, hint gone.
    expect(doneHint(container)).toBeNull();
    expect(
      doneCards(container)
        .map((c) => c.dataset.taskId)
        .sort(),
    ).toEqual(["d1", "t1"]);
  });

  it("a drop into another lane restores the done lane", async () => {
    const { container } = render(
      <Harness
        initial={[
          makeTask("t1", "Todo item", "todo"),
          makeTask("d1", "Done one", "done"),
        ]}
      />,
    );

    fireEvent.dragStart(card(container, "d1"), {
      dataTransfer: dataTransfer(),
    });
    await flushDragStart();
    expect(doneHint(container)).not.toBeNull();

    const todoCol = container.querySelector(
      '[data-column-id="todo"]',
    ) as HTMLElement;
    fireEvent.dragOver(todoCol);
    fireEvent.drop(todoCol);

    expect(doneHint(container)).toBeNull();
    expect(doneCards(container).map((c) => c.dataset.taskId)).toEqual([]);
  });

  it("a cancelled drag (dragend, no drop) restores the done lane", async () => {
    const onDrop = vi.fn();
    const { container } = render(
      <Harness
        initial={[
          makeTask("t1", "Todo item", "todo"),
          makeTask("d1", "Done one", "done"),
        ]}
        onDrop={onDrop}
      />,
    );

    fireEvent.dragStart(card(container, "t1"), {
      dataTransfer: dataTransfer(),
    });
    await flushDragStart();
    expect(doneHint(container)).not.toBeNull();

    // Escape / cancelled drag: dragend with no drop anywhere.
    fireEvent.dragEnd(card(container, "t1"));

    expect(onDrop).not.toHaveBeenCalled();
    expect(doneHint(container)).toBeNull();
    expect(doneCards(container).map((c) => c.dataset.taskId)).toEqual(["d1"]);
  });

  it("an empty done lane still shows the hint and accepts the drop", async () => {
    const onDrop = vi.fn();
    const { container } = render(
      <Harness initial={[makeTask("t1", "Todo item", "todo")]} onDrop={onDrop} />,
    );

    // Baseline: the empty-lane placeholder, not the hint.
    expect(doneHint(container)).toBeNull();
    expect(doneColumn(container)).toHaveTextContent("No tasks in done.");

    fireEvent.dragStart(card(container, "t1"), {
      dataTransfer: dataTransfer(),
    });
    await flushDragStart();

    const hint = doneHint(container);
    expect(hint).not.toBeNull();
    fireEvent.dragOver(doneColumn(container));
    fireEvent.drop(hint!);

    expect(onDrop).toHaveBeenCalledWith("t1", "done");
    expect(doneHint(container)).toBeNull();
    expect(doneCards(container).map((c) => c.dataset.taskId)).toEqual(["t1"]);
  });
});
