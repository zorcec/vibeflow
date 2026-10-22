import React from "react";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard, doneCountChipText } from "../KanbanBoard";
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

function makeTask(
  id: string,
  title: string,
  status: TaskStatus,
  links?: Task["links"],
): Task {
  return { id, title, status, links };
}

function renderBoard(tasks: Task[], doneTotal?: number | null) {
  return render(
    <KanbanBoard
      tasks={tasks}
      visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={vi.fn()}
      doneTotal={doneTotal}
    />,
  );
}

/** Header count text for one column. */
function headerText(container: HTMLElement, colId: string): string {
  const el = container.querySelector(
    `[data-column-id="${colId}"] [data-role="column-count"]`,
  );
  expect(el).toBeInTheDocument();
  return el!.textContent ?? "";
}

function countChip(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="done-count-chip"]');
}

describe("KanbanBoard done counts — one query for both (mqd8syq9)", () => {
  it("header shows `Done - N` from the single count source", () => {
    const { container } = renderBoard(
      [
        makeTask("d1", "Done one", "done"),
        makeTask("d2", "Done two", "done"),
        makeTask("t1", "Todo one", "todo"),
      ],
      1775,
    );
    expect(headerText(container, "done")).toBe("Done - 1775");
    // Other columns keep their own rendering.
    expect(headerText(container, "todo")).toBe("Todo · 1");
  });

  it("footer chip shows `showing X of N`", () => {
    const { container } = renderBoard(
      [
        makeTask("d1", "Done one", "done"),
        makeTask("d2", "Done two", "done"),
      ],
      1775,
    );
    const chip = countChip(container)!;
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("showing 2 of 1775");
  });

  it("a page action changes shown (X) and leaves total (N)", () => {
    const tasks = [
      makeTask("d1", "Done one", "done"),
      makeTask("d2", "Done two", "done"),
    ];
    const { container, rerender } = renderBoard(tasks, 1775);
    expect(countChip(container)).toHaveTextContent("showing 2 of 1775");
    rerender(
      <KanbanBoard
        tasks={[...tasks, makeTask("d3", "Done three", "done")]}
        visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
        searchQuery=""
        onOpenPanel={vi.fn()}
        onDrop={vi.fn()}
        doneTotal={1775}
      />,
    );
    // Shown grew with the newly loaded page; the total did not change.
    expect(countChip(container)).toHaveTextContent("showing 3 of 1775");
    expect(headerText(container, "done")).toBe("Done - 1775");
  });

  it("header and footer derive from exactly one count source", () => {
    const tasks = [makeTask("d1", "Done one", "done")];
    const { container, rerender } = renderBoard(tasks, 1775);
    expect(headerText(container, "done")).toBe("Done - 1775");
    expect(countChip(container)).toHaveTextContent("showing 1 of 1775");
    // Changing ONLY the single source moves both numbers together — no
    // second query, fetch, or prop feeds either of them.
    rerender(
      <KanbanBoard
        tasks={tasks}
        visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
        searchQuery=""
        onOpenPanel={vi.fn()}
        onDrop={vi.fn()}
        doneTotal={1776}
      />,
    );
    expect(headerText(container, "done")).toBe("Done - 1776");
    expect(countChip(container)).toHaveTextContent("showing 1 of 1776");
  });

  it("without doneTotal the legacy header renders and no chip appears", () => {
    const { container } = renderBoard([
      makeTask("d1", "Done one", "done"),
      makeTask("d2", "Done two", "done"),
    ]);
    expect(headerText(container, "done")).toBe("Done · 2");
    expect(countChip(container)).toBeNull();
  });

  it("the separate nested hint is removed for Done while the total is known", () => {
    const parent = makeTask("p1", "Done parent", "done");
    const child = makeTask("c1", "Nested child", "todo", [
      { taskId: "p1", type: "parent" },
    ]);
    const { container } = renderBoard([parent, child], 1775);
    expect(headerText(container, "done")).toBe("Done - 1775");
    expect(
      container.querySelector('[data-column-id="done"] [data-role="nested-hint"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-column-id="done"] [data-role="column-count"]')
        ?.getAttribute("data-nested-count"),
    ).toBeNull();
  });

  it("the count chip is the last child of the done scroll area", () => {
    const { container } = renderBoard(
      [makeTask("d1", "Done one", "done")],
      1775,
    );
    const scroll = container.querySelector(
      '[data-column-id="done"] .column-scroll',
    )!;
    expect(scroll.lastElementChild?.getAttribute("data-testid")).toBe(
      "done-count-chip",
    );
  });
});

describe("doneCountChipText (mqd8syq9)", () => {
  it("formats `showing X of N`", () => {
    expect(doneCountChipText(52, 1775)).toBe("showing 52 of 1775");
  });

  it("clamps a transient overshoot so the chip never reads X > N", () => {
    expect(doneCountChipText(53, 52)).toBe("showing 52 of 52");
  });
});
