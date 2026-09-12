import React from "react";
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard } from "../KanbanBoard";
import { dragSession, computeTreeReorder } from "../../task-links";
import type { Task } from "../../types";

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  // Deterministic 40px-tall rows → tree bands clamp to [5px, 10px]: clientY 5
  // is the top (before) band, clientY 35 is the bottom (after) band.
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

function makeTask(
  id: string,
  title: string,
  links?: Task["links"],
  updatedAt?: string,
): Task {
  return { id, title, status: "todo", links, updatedAt };
}

function dataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(() => ""), effectAllowed: "none" };
}

/**
 * jsdom has no DragEvent, and @testing-library's `fireEvent.dragOver` falls
 * back to a plain Event that drops `clientY` — so band classification always
 * saw `undefined` (centre). A raw MouseEvent keeps `clientY` (React's
 * onDragOver only keys on the event type) and lets the tests hit the exact
 * before/after bands.
 */
function dragOverAt(el: HTMLElement, clientY: number) {
  fireEvent(
    el,
    new MouseEvent("dragover", { bubbles: true, cancelable: true, clientY }),
  );
}

/**
 * Board wired to a shell that applies the tree reorder exactly like the CLI
 * kanban: resolve the drop against the rendered sibling order with the shared
 * `computeTreeReorder` helper, then persist the dragged key AND every
 * normalization patch the helper returns.
 */
function Harness({ initial }: { initial: Task[] }) {
  const [tasks, setTasks] = React.useState(initial);
  return (
    <KanbanBoard
      tasks={tasks}
      visibleCols={["todo"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={vi.fn()}
      onReorder={vi.fn()}
      onTreeReorder={(draggedId, targetId, position, parentId) => {
        setTasks((prev) => {
          const plan = computeTreeReorder(
            prev,
            draggedId,
            parentId,
            targetId,
            position,
          );
          if (!plan) return prev;
          const keys = new Map(
            plan.normalizationPatches.map((p) => [p.id, p.sortKey] as const),
          );
          keys.set(draggedId, plan.newSortKey);
          return prev.map((t) =>
            keys.has(t.id) ? { ...t, sortKey: keys.get(t.id) } : t,
          );
        });
      }}
    />
  );
}

function childRow(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(
    `[data-role="child-link-row"][data-task-id="${id}"]`,
  ) as HTMLElement;
}
function column(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector(`[data-column-id="${id}"]`) as HTMLElement;
}
/** Sibling order as rendered inside the card's inline tree. */
function siblingOrder(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-role="child-link-row"][data-task-id]',
    ),
  ].map((el) => el.getAttribute("data-task-id") ?? "");
}

describe("KanbanBoard tree DnD — sibling reorder order", () => {
  afterEach(() => {
    dragSession.end();
  });

  it("reorders keyless siblings into the intended order (drop after a sibling)", () => {
    // Neither sibling carries a sortKey — the common case for freshly linked
    // children. Rendered order is oldest-first: A, B.
    const initial = [
      makeTask("r1", "Root"),
      makeTask("a1", "Child A", [{ type: "parent", taskId: "r1" }], "2026-01-01"),
      makeTask("b1", "Child B", [{ type: "parent", taskId: "r1" }], "2026-01-02"),
    ];
    const { container } = render(<Harness initial={initial} />);

    expect(siblingOrder(container)).toEqual(["a1", "b1"]);

    // Drag A onto the bottom band of B → "after B".
    fireEvent.dragStart(childRow(container, "a1"), {
      dataTransfer: dataTransfer(),
    });
    dragOverAt(childRow(container, "b1"), 35);
    fireEvent.drop(column(container, "todo"));

    expect(siblingOrder(container)).toEqual(["b1", "a1"]);
  });

  it("reorders a keyless sibling before another (drop before a sibling)", () => {
    const initial = [
      makeTask("r1", "Root"),
      makeTask("a1", "Child A", [{ type: "parent", taskId: "r1" }], "2026-01-01"),
      makeTask("b1", "Child B", [{ type: "parent", taskId: "r1" }], "2026-01-02"),
    ];
    const { container } = render(<Harness initial={initial} />);

    // Drag B onto the top band of A → "before A" (already the case → stable).
    fireEvent.dragStart(childRow(container, "b1"), {
      dataTransfer: dataTransfer(),
    });
    dragOverAt(childRow(container, "a1"), 5);
    fireEvent.drop(column(container, "todo"));

    expect(siblingOrder(container)).toEqual(["b1", "a1"]);
  });

  it("reorders among three keyless siblings (drag first after last)", () => {
    const initial = [
      makeTask("r1", "Root"),
      makeTask("a1", "A", [{ type: "parent", taskId: "r1" }], "2026-01-01"),
      makeTask("b1", "B", [{ type: "parent", taskId: "r1" }], "2026-01-02"),
      makeTask("c1", "C", [{ type: "parent", taskId: "r1" }], "2026-01-03"),
    ];
    const { container } = render(<Harness initial={initial} />);

    expect(siblingOrder(container)).toEqual(["a1", "b1", "c1"]);

    fireEvent.dragStart(childRow(container, "a1"), {
      dataTransfer: dataTransfer(),
    });
    dragOverAt(childRow(container, "c1"), 35);
    fireEvent.drop(column(container, "todo"));

    expect(siblingOrder(container)).toEqual(["b1", "c1", "a1"]);
  });
});
