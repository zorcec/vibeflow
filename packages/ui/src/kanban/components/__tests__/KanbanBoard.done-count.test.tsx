import React from "react";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard, doneHiddenCount } from "../KanbanBoard";
import type { Task, TaskStatus } from "../../types";

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {};
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

/** The single bottom line of the done lane (`+N more`), if rendered. */
function moreChip(container: HTMLElement): HTMLElement | null {
  return container.querySelector(
    '[data-column-id="done"] [data-fit-chip]',
  );
}

// jsdom has no layout, so the done lane falls back to the unmeasured cap
// (DONE_LIMIT = 10): every task up to 10 renders, the rest is remainder.
describe("KanbanBoard done counts — header total + `+N more` (d2zka3bd)", () => {
  it("header shows the TOTAL (`Done · N`) from the single count source", () => {
    const { container } = renderBoard(
      [
        makeTask("d1", "Done one", "done"),
        makeTask("d2", "Done two", "done"),
        makeTask("t1", "Todo one", "todo"),
      ],
      1956,
    );
    expect(headerText(container, "done")).toBe("Done · 1956");
    // Other columns keep their own rendering.
    expect(headerText(container, "todo")).toBe("Todo · 1");
  });

  it("bottom line shows `+N more` with N = total − rendered", () => {
    const { container } = renderBoard(
      [
        makeTask("d1", "Done one", "done"),
        makeTask("d2", "Done two", "done"),
      ],
      1956,
    );
    const chip = moreChip(container)!;
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("+1954 more");
  });

  it("a page action shrinks the remainder and leaves the total", () => {
    const tasks = [
      makeTask("d1", "Done one", "done"),
      makeTask("d2", "Done two", "done"),
    ];
    const { container, rerender } = renderBoard(tasks, 1956);
    expect(moreChip(container)).toHaveTextContent("+1954 more");
    rerender(
      <KanbanBoard
        tasks={[...tasks, makeTask("d3", "Done three", "done")]}
        visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
        searchQuery=""
        onOpenPanel={vi.fn()}
        onDrop={vi.fn()}
        doneTotal={1956}
      />,
    );
    // One more card on screen; the total did not change.
    expect(moreChip(container)).toHaveTextContent("+1953 more");
    expect(headerText(container, "done")).toBe("Done · 1956");
  });

  it("header and bottom line derive from exactly one count source", () => {
    const tasks = [makeTask("d1", "Done one", "done")];
    const { container, rerender } = renderBoard(tasks, 1956);
    expect(headerText(container, "done")).toBe("Done · 1956");
    expect(moreChip(container)).toHaveTextContent("+1955 more");
    // Changing ONLY the single source moves both numbers together — no
    // second query, fetch, or prop feeds either of them.
    rerender(
      <KanbanBoard
        tasks={tasks}
        visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
        searchQuery=""
        onOpenPanel={vi.fn()}
        onDrop={vi.fn()}
        doneTotal={1957}
      />,
    );
    expect(headerText(container, "done")).toBe("Done · 1957");
    expect(moreChip(container)).toHaveTextContent("+1956 more");
  });

  it("no bottom line when everything fits (remainder is zero)", () => {
    const { container } = renderBoard(
      [makeTask("d1", "Done one", "done")],
      1,
    );
    expect(headerText(container, "done")).toBe("Done · 1");
    expect(moreChip(container)).toBeNull();
  });

  it("no `shown X of N` duplicate line anywhere in the done lane", () => {
    const { container } = renderBoard(
      [makeTask("d1", "Done one", "done")],
      1956,
    );
    const lane = container.querySelector('[data-column-id="done"]')!;
    expect(lane.textContent).not.toMatch(/shown/i);
    expect(
      container.querySelector('[data-testid="done-count-chip"]'),
    ).toBeNull();
  });

  it("without doneTotal the legacy header renders and fit-only chip stays", () => {
    const { container } = renderBoard([
      makeTask("d1", "Done one", "done"),
      makeTask("d2", "Done two", "done"),
    ]);
    expect(headerText(container, "done")).toBe("Done · 2");
    expect(moreChip(container)).toBeNull();
  });

  it("the separate nested hint is removed for Done while the total is known", () => {
    const parent = makeTask("p1", "Done parent", "done");
    const child = makeTask("c1", "Nested child", "todo", [
      { taskId: "p1", type: "parent" },
    ]);
    const { container } = renderBoard([parent, child], 1956);
    expect(headerText(container, "done")).toBe("Done · 1956");
    expect(
      container.querySelector('[data-column-id="done"] [data-role="nested-hint"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-column-id="done"] [data-role="column-count"]')
        ?.getAttribute("data-nested-count"),
    ).toBeNull();
  });

  it("the `+N more` line is the last child of the done scroll area", () => {
    const { container } = renderBoard(
      [makeTask("d1", "Done one", "done")],
      1956,
    );
    const scroll = container.querySelector(
      '[data-column-id="done"] .column-scroll',
    )!;
    expect(scroll.lastElementChild?.hasAttribute("data-fit-chip")).toBe(true);
  });
});

describe("doneHiddenCount (d2zka3bd)", () => {
  it("returns total − rendered", () => {
    expect(doneHiddenCount(52, 1956)).toBe(1904);
    expect(doneHiddenCount(0, 1956)).toBe(1956);
  });

  it("clamps a transient overshoot to zero, never negative", () => {
    expect(doneHiddenCount(53, 52)).toBe(0);
    expect(doneHiddenCount(1956, 1956)).toBe(0);
  });
});
