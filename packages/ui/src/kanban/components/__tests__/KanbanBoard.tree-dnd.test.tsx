import React from "react";
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard } from "../KanbanBoard";
import { dragSession } from "../../task-links";
import type { Task } from "../../types";

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  // jsdom returns a zero rect; a deterministic 40px-tall card/row makes the
  // centre (make-child) band reachable for the card-centre cases below.
  Element.prototype.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 40,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function makeTask(id: string, title: string, links?: Task["links"]): Task {
  return { id, title, status: "todo", links };
}

function dataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(() => ""), effectAllowed: "none" };
}

/**
 * Board wired to a shell that applies BOTH drop outcomes the CLI/web kanban
 * perform: link-as-child (parentless) and reparent (already-parented,
 * single-parent rule allows the move by replacing the existing parent link).
 */
function Harness({
  initial,
  onLinkChild,
  onTreeReparent,
}: {
  initial: Task[];
  onLinkChild?: (draggedId: string, parentId: string) => void;
  onTreeReparent?: (
    draggedId: string,
    parentId: string,
    targetId?: string,
  ) => void;
}) {
  const [tasks, setTasks] = React.useState(initial);
  const setParent = (draggedId: string, parentId: string) =>
    setTasks((prev) =>
      prev.map((t) =>
        t.id === draggedId
          ? {
              ...t,
              links: [
                ...(t.links ?? []).filter((l) => l?.type !== "parent"),
                { type: "parent" as const, taskId: parentId },
              ],
            }
          : t,
      ),
    );
  return (
    <KanbanBoard
      tasks={tasks}
      visibleCols={["todo"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={vi.fn()}
      onReorder={vi.fn()}
      onLinkChild={(draggedId, parentId) => {
        onLinkChild?.(draggedId, parentId);
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
      }}
      onTreeReparent={(draggedId, parentId, targetId) => {
        onTreeReparent?.(draggedId, parentId, targetId);
        setParent(draggedId, parentId);
      }}
    />
  );
}

function card(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`article[data-task-id="${id}"]`) as HTMLElement;
}
function cardWrapper(container: HTMLElement, id: string): HTMLElement {
  return card(container, id).parentElement as HTMLElement;
}
function column(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`[data-column-id="${id}"]`) as HTMLElement;
}
function childrenZone(container: HTMLElement, id: string): HTMLElement {
  return card(container, id).querySelector(
    '[data-drop-role="children-zone"]',
  ) as HTMLElement;
}
function childRow(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(
    `[data-role="child-link-row"][data-task-id="${id}"]`,
  ) as HTMLElement;
}
/** Nesting depth of a rendered row (1 = direct child of a card). */
function rowDepth(container: HTMLElement, id: string): string | null {
  return (
    childRow(container, id)
      ?.closest('[data-role="recursive-tree-node"]')
      ?.getAttribute("data-depth") ?? null
  );
}

/** root → childA → grandchild (+ childB), all in one column. */
function tree() {
  return [
    makeTask("r1", "Root"),
    makeTask("a1", "Child A", [{ type: "parent", taskId: "r1" }]),
    makeTask("b1", "Child B", [{ type: "parent", taskId: "r1" }]),
    makeTask("g1", "Grandchild", [{ type: "parent", taskId: "a1" }]),
  ];
}

describe("KanbanBoard tree DnD — moving a nested child back to the root parent", () => {
  afterEach(() => {
    dragSession.end();
  });

  it("dropping a grandchild on the root parent's children zone reparents it to the root", () => {
    const onTreeReparent = vi.fn();
    const { container } = render(
      <Harness initial={tree()} onTreeReparent={onTreeReparent} />,
    );

    // Sanity: the grandchild starts nested one level under child A.
    expect(rowDepth(container, "g1")).toBe("2");

    fireEvent.dragStart(childRow(container, "g1"), {
      dataTransfer: dataTransfer(),
    });
    fireEvent.dragOver(childrenZone(container, "r1"));
    fireEvent.drop(childrenZone(container, "r1"));

    expect(onTreeReparent).toHaveBeenCalledWith("g1", "r1", undefined);
    // Observable outcome: the grandchild is now a direct child of the root.
    expect(rowDepth(container, "g1")).toBe("1");
  });

  it("dropping a grandchild on the root parent card (centre) reparents it to the root", () => {
    const onTreeReparent = vi.fn();
    const { container } = render(
      <Harness initial={tree()} onTreeReparent={onTreeReparent} />,
    );

    fireEvent.dragStart(childRow(container, "g1"), {
      dataTransfer: dataTransfer(),
    });
    fireEvent.dragOver(cardWrapper(container, "r1"), { clientY: 20 });
    fireEvent.drop(column(container, "todo"));

    expect(onTreeReparent).toHaveBeenCalledWith("g1", "r1", undefined);
    expect(rowDepth(container, "g1")).toBe("1");
  });

  it("still rejects reparenting under a descendant (cycle guard intact)", () => {
    const onTreeReparent = vi.fn();
    const onLinkChild = vi.fn();
    const { container } = render(
      <Harness
        initial={tree()}
        onTreeReparent={onTreeReparent}
        onLinkChild={onLinkChild}
      />,
    );

    // childA is an ancestor of grandchild — dragging the parent onto its own
    // descendant's row (centre band) must not create a cycle.
    fireEvent.dragStart(childRow(container, "a1"), {
      dataTransfer: dataTransfer(),
    });
    fireEvent.dragOver(childRow(container, "g1"), { clientY: 20 });
    fireEvent.drop(column(container, "todo"));

    expect(onTreeReparent).not.toHaveBeenCalled();
    expect(onLinkChild).not.toHaveBeenCalled();
    expect(rowDepth(container, "g1")).toBe("2");
  });

  it("still links a parentless task as a child (no regression)", () => {
    const onLinkChild = vi.fn();
    const { container } = render(
      <Harness
        initial={[
          makeTask("r1", "Root"),
          makeTask("c1", "Existing child", [{ type: "parent", taskId: "r1" }]),
          makeTask("x1", "Free"),
        ]}
        onLinkChild={onLinkChild}
      />,
    );

    fireEvent.dragStart(card(container, "x1"), {
      dataTransfer: dataTransfer(),
    });
    fireEvent.dragOver(cardWrapper(container, "r1"), { clientY: 20 });
    fireEvent.drop(column(container, "todo"));

    expect(onLinkChild).toHaveBeenCalledWith("x1", "r1");
    expect(rowDepth(container, "x1")).toBe("1");
  });
});
