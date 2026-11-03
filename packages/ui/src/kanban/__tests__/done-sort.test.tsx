import React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { compareDoneOrder } from "../utils";
import { KanbanBoard } from "../components/KanbanBoard";
import { KanbanListView } from "../components/KanbanListView";
import type { Task, TaskStatus } from "../types";

// jsdom has no ResizeObserver — the board's fit-to-screen effect needs one.
beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

function doneTask(
  id: string,
  updatedAt: string | undefined,
  extra: Partial<Task> = {},
): Task {
  return { id, title: id, status: "done", updatedAt, ...extra };
}

describe("done-group recency sort (e35p3cfeofp3zoivi7og8ivq)", () => {
  it("compareDoneOrder puts the most-recently-modified task first", () => {
    const tasks = [
      doneTask("old", "2026-09-01T00:00:00.000Z"),
      doneTask("new", "2026-10-26T00:00:00.000Z"),
      doneTask("mid", "2026-10-01T00:00:00.000Z"),
    ];
    expect([...tasks].sort(compareDoneOrder).map((t) => t.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("compareDoneOrder ignores sortKey and falls back to createdAt", () => {
    // A stale card dragged to the top (lowest sortKey) must NOT outrank a
    // recently closed card: recency wins, sortKeys are ignored in done.
    const tasks = [
      doneTask("stale-top", "2026-09-01T00:00:00.000Z", { sortKey: "a0" }),
      doneTask("fresh", "2026-10-26T00:00:00.000Z", { sortKey: "a9" }),
      { id: "nodates", title: "nodates", status: "done" } as Task,
    ];
    expect([...tasks].sort(compareDoneOrder).map((t) => t.id)).toEqual([
      "fresh",
      "stale-top",
      "nodates",
    ]);
  });

  it("board done column renders the most-recently-modified card first", () => {
    const tasks: Task[] = [
      {
        id: "old",
        title: "Old",
        status: "done",
        updatedAt: "2026-09-01T00:00:00.000Z",
        sortKey: "a0",
      },
      {
        id: "new",
        title: "New",
        status: "done",
        updatedAt: "2026-10-26T00:00:00.000Z",
        sortKey: "a9",
      },
    ];
    const { container } = render(
      <KanbanBoard
        tasks={tasks}
        visibleCols={["done"] as TaskStatus[]}
        searchQuery=""
        onOpenPanel={vi.fn()}
        onDrop={vi.fn()}
        onReorder={vi.fn()}
        onLinkChild={vi.fn()}
        onTreeReparent={vi.fn()}
      />,
    );
    const ids = [
      ...container.querySelectorAll<HTMLElement>(
        '[data-column-id="done"] article[data-task-id]',
      ),
    ].map((c) => c.dataset.taskId);
    expect(ids).toEqual(["new", "old"]);
  });

  it("list view done group renders the most-recently-modified row first", () => {
    const tasks: Task[] = [
      doneTask("old", "2026-09-01T00:00:00.000Z"),
      doneTask("new", "2026-10-26T00:00:00.000Z"),
    ];
    const { container } = render(
      <KanbanListView
        tasks={tasks}
        searchQuery=""
        onOpenPanel={vi.fn()}
        onAddTask={vi.fn()}
        onDrop={vi.fn()}
      />,
    );
    const ids = [...container.querySelectorAll("[data-task-id]")].map((el) =>
      el.getAttribute("data-task-id"),
    );
    expect(ids).toEqual(["new", "old"]);
  });

  it("other groups keep their order — done sort does not leak", () => {
    const tasks: Task[] = [
      { id: "t1", title: "T1", status: "todo" },
      { id: "t2", title: "T2", status: "todo" },
      doneTask("old", "2026-09-01T00:00:00.000Z"),
      doneTask("new", "2026-10-26T00:00:00.000Z"),
    ];
    const { container } = render(
      <KanbanListView
        tasks={tasks}
        searchQuery=""
        onOpenPanel={vi.fn()}
        onAddTask={vi.fn()}
        onDrop={vi.fn()}
      />,
    );
    const ids = [...container.querySelectorAll("[data-task-id]")].map((el) =>
      el.getAttribute("data-task-id"),
    );
    // todo group first (STATUS_ORDER), insertion order preserved; done last,
    // most-recent first.
    expect(ids).toEqual(["t1", "t2", "new", "old"]);
  });
});
