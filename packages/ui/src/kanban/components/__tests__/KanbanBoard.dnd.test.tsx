import React from "react";
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard } from "../KanbanBoard";
import { dragSession } from "../../task-links";
import type { Task } from "../../types";

// jsdom has no ResizeObserver — the board's fit-to-screen effect needs one.
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

function makeTask(id: string, title: string, links?: Task["links"]): Task {
  return { id, title, status: "todo", links };
}

/** Minimal DataTransfer stand-in — jsdom implements neither DataTransfer nor
 *  DragEvent, and @testing-library only attaches `init.dataTransfer` when an
 *  object is supplied. */
function dataTransfer() {
  return {
    setData: vi.fn(),
    getData: vi.fn(() => ""),
    effectAllowed: "none",
  };
}

const DRAG_CLASSES = [
  "dragging",
  "dnd-drop-center",
  "dnd-drop-blocked",
  "dnd-zone-hover",
];

/** Board wired to a shell that applies the reparent the CLI/web kanban
 *  performs (optimistic link + re-render), so a drop can really move a card and
 *  unmount the drag source — the case that historically leaked drag state. */
function BoardHarness({
  initial,
  removeId,
  onLinkChild,
  onTreeReparent,
}: {
  initial: Task[];
  /** Removed from the board mid-drag to simulate a live update taking the drag
   *  source away while the drag is still in flight. */
  removeId?: string | null;
  onLinkChild?: (draggedId: string, parentId: string) => void;
  onTreeReparent?: (
    draggedId: string,
    parentId: string,
    targetId?: string,
  ) => void;
}) {
  const [tasks, setTasks] = React.useState(initial);
  const visible = removeId ? tasks.filter((t) => t.id !== removeId) : tasks;
  const link = (draggedId: string, parentId: string) =>
    setTasks((prev) =>
      prev.map((t) =>
        t.id === draggedId
          ? {
              ...t,
              links: [
                ...(t.links ?? []),
                { type: "parent" as const, taskId: parentId },
              ],
            }
          : t,
      ),
    );
  return (
    <KanbanBoard
      tasks={visible}
      visibleCols={["todo"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={vi.fn()}
      onReorder={vi.fn()}
      onLinkChild={(draggedId, parentId) => {
        onLinkChild?.(draggedId, parentId);
        link(draggedId, parentId);
      }}
      onTreeReparent={(draggedId, parentId, targetId) => {
        onTreeReparent?.(draggedId, parentId, targetId);
        link(draggedId, parentId);
      }}
    />
  );
}

function card(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`article[data-task-id="${id}"]`);
}

/** The column wrapper that owns the card-level dragover/drop intent. */
function cardWrapper(container: HTMLElement, id: string): HTMLElement {
  return card(container, id)!.parentElement as HTMLElement;
}

/** The children drop zone rendered inside a card that has leaf descendants. */
function childrenZone(container: HTMLElement, id: string): HTMLElement | null {
  return card(container, id)!.querySelector('[data-drop-role="children-zone"]');
}

/** Every leftover drag affordance: imperative classes + phantom drop slots. */
function dragArtifacts(container: HTMLElement): HTMLElement[] {
  const selector = DRAG_CLASSES.map((c) => `.${c}`).join(", ");
  return [
    ...container.querySelectorAll<HTMLElement>(selector),
    ...container.querySelectorAll<HTMLElement>(
      '[data-role="empty-child-slot"]',
    ),
  ];
}

/** Start a drag, hover a target card's children zone and assert the board's
 *  controller still reacts (the zone intent paints `dnd-zone-hover`).
 *  Zone hover is used because it is geometry-independent in jsdom. */
function expectControllerAlive(
  container: HTMLElement,
  sourceId: string,
  hoveredCardId: string,
) {
  fireEvent.dragStart(card(container, sourceId)!, {
    dataTransfer: dataTransfer(),
  });
  expect(dragSession.get()).toBe(sourceId);
  const zone = childrenZone(container, hoveredCardId);
  expect(zone).not.toBeNull();
  fireEvent.dragOver(zone!);
  expect(cardWrapper(container, hoveredCardId).className).toContain(
    "dnd-zone-hover",
  );
}

describe("KanbanBoard drag-and-drop invariants", () => {
  afterEach(() => {
    dragSession.end();
    document.body.className = "";
  });

  it("a drop on a children zone leaves no drag state and the next drag reaches the board", () => {
    const alpha = makeTask("a1", "Alpha");
    const beta = makeTask("b1", "Beta");
    const child = makeTask("c1", "Child", [{ type: "parent", taskId: "b1" }]);
    const delta = makeTask("d1", "Delta");
    const onLinkChild = vi.fn();
    const { container } = render(
      <BoardHarness
        initial={[alpha, beta, child, delta]}
        onLinkChild={onLinkChild}
      />,
    );

    const zone = childrenZone(container, "b1");
    expect(zone).toBeInTheDocument();

    fireEvent.dragStart(card(container, "a1")!, {
      dataTransfer: dataTransfer(),
    });
    expect(dragSession.get()).toBe("a1");
    fireEvent.dragOver(zone!);
    fireEvent.drop(zone!);

    // The drop did what it was asked to do…
    expect(onLinkChild).toHaveBeenCalledWith("a1", "b1");
    // …and nothing drag-related survived it.
    expect(dragSession.get()).toBeNull();
    expect(dragArtifacts(container)).toEqual([]);
    expect(document.body.className).not.toMatch(/dnd-|dragging/);

    // The invariant that matters: the board still accepts a brand-new drag.
    expectControllerAlive(container, "d1", "b1");
  });

  it("cleanup completes when the drag source unmounts mid-drag", () => {
    const alpha = makeTask("a1", "Alpha");
    const beta = makeTask("b1", "Beta");
    const child = makeTask("c1", "Child", [{ type: "parent", taskId: "b1" }]);
    const delta = makeTask("d1", "Delta");
    const { container, rerender } = render(
      <BoardHarness initial={[alpha, beta, child, delta]} />,
    );

    fireEvent.dragStart(card(container, "a1")!, {
      dataTransfer: dataTransfer(),
    });
    expect(dragSession.get()).toBe("a1");

    // Live update removes the drag source while the drag is in flight — its
    // own dragend can never be delivered.
    rerender(
      <BoardHarness initial={[alpha, beta, child, delta]} removeId="a1" />,
    );
    expect(card(container, "a1")).toBeNull();
    expect(dragSession.get()).toBe("a1");

    // The window listener is the last line of defence.
    act(() => {
      window.dispatchEvent(new Event("dragend"));
    });
    expect(dragSession.get()).toBeNull();
    expect(dragArtifacts(container)).toEqual([]);
    // A new drag reaches the controller again.
    expectControllerAlive(container, "d1", "b1");
  });

  it("strips imperative drag classes when only the window-level dragend runs", () => {
    const alpha = makeTask("a1", "Alpha");
    const beta = makeTask("b1", "Beta");
    const { container } = render(<BoardHarness initial={[alpha, beta]} />);

    const source = card(container, "a1")!;
    fireEvent.dragStart(source, { dataTransfer: dataTransfer() });
    expect(source.classList.contains("dragging")).toBe(true);
    // An intent class as React would have applied it to the drop target.
    const target = cardWrapper(container, "b1");
    target.classList.add("dnd-drop-center");

    // dragend delivered at the window only — the source's own React handler is
    // not on the event path (source replaced by a re-render mid-drag).
    act(() => {
      window.dispatchEvent(new Event("dragend"));
    });

    expect(source.classList.contains("dragging")).toBe(false);
    expect(target.classList.contains("dnd-drop-center")).toBe(false);
    expect(dragSession.get()).toBeNull();
    expect(dragArtifacts(container)).toEqual([]);
  });

  it("a rejected reparent still releases the drop context", () => {
    // Dropping alpha onto its own descendant is rejected — the board must
    // still be usable afterwards.
    const alpha = makeTask("a1", "Alpha");
    const beta = makeTask("b1", "Beta", [{ type: "parent", taskId: "a1" }]);
    const gamma = makeTask("g1", "Gamma", [{ type: "parent", taskId: "b1" }]);
    const delta = makeTask("d1", "Delta");
    const onTreeReparent = vi.fn();
    const { container } = render(
      <BoardHarness
        initial={[alpha, beta, gamma, delta]}
        onTreeReparent={onTreeReparent}
      />,
    );

    fireEvent.dragStart(card(container, "a1")!, {
      dataTransfer: dataTransfer(),
    });
    const row = container.querySelector('[data-task-id="g1"]') as HTMLElement;
    expect(row).toBeInTheDocument();
    fireEvent.dragOver(row);
    fireEvent.drop(row);

    expect(onTreeReparent).not.toHaveBeenCalled();
    expect(dragSession.get()).toBeNull();
    expect(dragArtifacts(container)).toEqual([]);
    // And the board still accepts the next drag.
    expectControllerAlive(container, "d1", "a1");
  });
});
