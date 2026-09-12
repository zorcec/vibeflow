import React from "react";
import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard } from "../KanbanBoard";
import { dragSession } from "../../task-links";
import type { Task } from "../../types";

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom returns a zero rect, so every dragover would classify as a top edge.
  // A deterministic 40px-tall card makes a mid-card dragover classify as the
  // center (make-child) band, the gesture these tests exercise.
  Element.prototype.getBoundingClientRect = () => ({
      top: 0,
      bottom: 40,
      left: 0,
      right: 200,
      width: 200,
      height: 40,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect);
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

interface HarnessProps {
  initial: Task[];
  onLinkChild?: (draggedId: string, parentId: string) => void;
  onDrop?: (taskId: string, status: Task["status"]) => void;
  onReorder?: (
    taskId: string,
    newStatus: Task["status"],
    beforeId: string | null,
    afterId: string | null,
  ) => void;
}

/** Board wired to a shell that applies both drop outcomes (link-as-child and
 *  status change), so a drop visibly mutates the board — not just a spy. */
function Harness({ initial, onLinkChild, onDrop, onReorder }: HarnessProps) {
  const [tasks, setTasks] = React.useState(initial);
  return (
    <KanbanBoard
      tasks={tasks}
      visibleCols={["backlog", "todo"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={(taskId, status) => {
        onDrop?.(taskId, status);
        setTasks((prev) =>
          prev.map((t) => (t.id === taskId ? { ...t, status } : t)),
        );
      }}
      onReorder={onReorder ?? vi.fn()}
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
      onTreeReparent={vi.fn()}
    />
  );
}

function card(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(
    `article[data-task-id="${id}"]`,
  ) as HTMLElement;
}
/** The column wrapper that owns the card-level dragover intent. */
function cardWrapper(container: HTMLElement, id: string): HTMLElement {
  return card(container, id).parentElement as HTMLElement;
}
function column(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`[data-column-id="${id}"]`) as HTMLElement;
}
function childrenZone(container: HTMLElement, id: string): HTMLElement | null {
  return card(container, id).querySelector('[data-drop-role="children-zone"]');
}
/** A task that rendered as a tree row (i.e. it now has a parent link). */
function childRow(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(
    `[data-role="child-link-row"][data-task-id="${id}"]`,
  );
}

/** A drag source outside the board columns — the detail-panel Relations tree —
 *  registers itself only through the dragSession singleton. It never calls the
 *  board's onDragStart, so dragTaskIdRef.current stays null for the whole drag. */
function beginSessionOnlyDrag(id: string) {
  dragSession.begin(id);
}

describe("KanbanBoard session-registered drag sources", () => {
  afterEach(() => {
    dragSession.end();
  });

  it("a card drop rejected by the parent rule does not poison the next drag from a session-only source", () => {
    // Alpha already has a parent, so a card-center drop onto Beta is rejected.
    const alpha = makeTask("a1", "Alpha", [{ type: "parent", taskId: "z9" }]);
    const beta = makeTask("b1", "Beta");
    const delta = makeTask("d1", "Delta");
    const onLinkChild = vi.fn();
    const { container } = render(
      <Harness initial={[alpha, beta, delta]} onLinkChild={onLinkChild} />,
    );

    // First drag: a board card onto a target the parent rule rejects.
    fireEvent.dragStart(card(container, "a1"), {
      dataTransfer: dataTransfer(),
    });
    fireEvent.dragOver(cardWrapper(container, "b1"), { clientY: 20 });
    fireEvent.drop(column(container, "todo"));
    expect(onLinkChild).not.toHaveBeenCalled();

    // Second drag: a session-only source (the detail panel's tree rows).
    beginSessionOnlyDrag("d1");
    fireEvent.dragOver(cardWrapper(container, "b1"), { clientY: 20 });
    fireEvent.drop(column(container, "todo"));

    expect(onLinkChild).toHaveBeenCalledWith("d1", "b1");
    // Observable outcome: Delta now renders as a tree row under Beta.
    expect(childRow(container, "d1")).not.toBeNull();
  });

  it("a session-only drag over a card produces a card intent and links on drop", () => {
    const alpha = makeTask("a1", "Alpha");
    const beta = makeTask("b1", "Beta");
    const onLinkChild = vi.fn();
    const { container } = render(
      <Harness initial={[alpha, beta]} onLinkChild={onLinkChild} />,
    );

    beginSessionOnlyDrag("a1");
    fireEvent.dragOver(cardWrapper(container, "b1"), { clientY: 20 });

    // The intent is live: the make-child pill is rendered for the target.
    expect(container.querySelector(".dnd-make-child-pill")).not.toBeNull();

    fireEvent.drop(column(container, "todo"));
    expect(onLinkChild).toHaveBeenCalledWith("a1", "b1");
    expect(childRow(container, "a1")).not.toBeNull();
  });

  it("a session-only drag over a children zone produces a zone intent and links on drop", () => {
    const alpha = makeTask("a1", "Alpha");
    const beta = makeTask("b1", "Beta");
    const child = makeTask("c1", "Child", [{ type: "parent", taskId: "b1" }]);
    const onLinkChild = vi.fn();
    const { container } = render(
      <Harness initial={[alpha, beta, child]} onLinkChild={onLinkChild} />,
    );

    const zone = childrenZone(container, "b1");
    expect(zone).not.toBeNull();

    beginSessionOnlyDrag("a1");
    fireEvent.dragOver(zone!);
    fireEvent.drop(zone!);

    expect(onLinkChild).toHaveBeenCalledWith("a1", "b1");
    expect(childRow(container, "a1")).not.toBeNull();
  });

  it("a session-only drag dropped on a column background still changes status", () => {
    const alpha = makeTask("a1", "Alpha");
    const beta = makeTask("b1", "Beta");
    const onDrop = vi.fn();
    const { container } = render(
      <Harness initial={[alpha, beta]} onDrop={onDrop} />,
    );

    beginSessionOnlyDrag("a1");
    fireEvent.dragOver(column(container, "backlog"));
    fireEvent.drop(column(container, "backlog"));

    expect(onDrop).toHaveBeenCalledWith("a1", "backlog");
    expect(
      card(container, "a1").closest("[data-column-id]")?.getAttribute(
        "data-column-id",
      ),
    ).toBe("backlog");
  });

  it("a rejected card drop does not poison the next card drag", () => {
    const alpha = makeTask("a1", "Alpha", [{ type: "parent", taskId: "z9" }]);
    const beta = makeTask("b1", "Beta");
    const delta = makeTask("d1", "Delta");
    const onLinkChild = vi.fn();
    const { container } = render(
      <Harness initial={[alpha, beta, delta]} onLinkChild={onLinkChild} />,
    );

    fireEvent.dragStart(card(container, "a1"), {
      dataTransfer: dataTransfer(),
    });
    fireEvent.dragOver(cardWrapper(container, "b1"), { clientY: 20 });
    fireEvent.drop(column(container, "todo"));
    expect(onLinkChild).not.toHaveBeenCalled();

    fireEvent.dragStart(card(container, "d1"), {
      dataTransfer: dataTransfer(),
    });
    fireEvent.dragOver(cardWrapper(container, "b1"), { clientY: 20 });
    fireEvent.drop(column(container, "todo"));

    expect(onLinkChild).toHaveBeenCalledWith("d1", "b1");
    expect(childRow(container, "d1")).not.toBeNull();
  });
});
