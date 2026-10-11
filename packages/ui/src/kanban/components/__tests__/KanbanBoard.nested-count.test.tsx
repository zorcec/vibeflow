import React from "react";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KanbanBoard } from "../KanbanBoard";
import type { Task, TaskStatus } from "../../types";

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function makeTask(
  id: string,
  title: string,
  status: TaskStatus,
  links?: Task["links"],
): Task {
  return { id, title, status, links };
}

function childOf(parentId: string): Task["links"] {
  return [{ taskId: parentId, type: "parent" }];
}

function renderBoard(tasks: Task[]) {
  return render(
    <KanbanBoard
      tasks={tasks}
      visibleCols={["backlog", "todo", "in-progress", "review", "done"]}
      searchQuery=""
      onOpenPanel={vi.fn()}
      onDrop={vi.fn()}
    />,
  );
}

/** Header count text for one column, e.g. `Review · 2 (+3 nested)`. */
function headerText(container: HTMLElement, colId: string): string {
  const el = container.querySelector(
    `[data-column-id="${colId}"] [data-role="column-count"]`,
  );
  expect(el).toBeInTheDocument();
  return el!.textContent ?? "";
}

describe("KanbanBoard honest per-status header (c8160a0c)", () => {
  it("header shows the plain card count when nothing is nested", () => {
    const { container } = renderBoard([
      makeTask("r1", "Review one", "review"),
      makeTask("r2", "Review two", "review"),
      makeTask("t1", "Todo one", "todo"),
    ]);
    expect(headerText(container, "review")).toBe("Review · 2");
    // Zero nested: no suffix, no hint attributes — byte-identical to before.
    const header = container.querySelector(
      '[data-column-id="review"] [data-role="column-count"]',
    )!;
    expect(header).not.toHaveTextContent("nested");
    expect(header.getAttribute("data-nested-count")).toBeNull();
    expect(header.getAttribute("title")).toBeNull();
  });

  it("header shows standalone + nested breakdown when children carry the column status", () => {
    const tasks = [
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("r1", "Review one", "review"),
      makeTask("r2", "Review two", "review"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
      makeTask("c2", "Nested review B", "review", childOf("epic")),
      makeTask("c3", "Nested review C", "review", childOf("epic")),
    ];
    const { container } = renderBoard(tasks);
    // NON-VACUOUS: this header must differ from the zero-nested header above.
    expect(headerText(container, "review")).toBe("Review · 2 (+3 nested)");
    // The parent's own column is unaffected — no nested in-progress tasks.
    expect(headerText(container, "in-progress")).toBe("In Progress · 1");
  });

  it("the nested count is reachable via hover title on the header", () => {
    const { container } = renderBoard([
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("r1", "Review one", "review"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
    ]);
    const header = container.querySelector(
      '[data-column-id="review"] [data-role="column-count"]',
    )!;
    expect(header.getAttribute("data-nested-count")).toBe("1");
    // The title states the full breakdown: total, cards, and nested.
    expect(header.getAttribute("title")).toBe(
      "2 tasks have status Review: 1 shown as cards, 1 nested inside parent cards in other columns",
    );
  });

  it("standalone + nested reconciles with every task carrying the status", () => {
    const tasks = [
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("r1", "Review one", "review"),
      makeTask("r2", "Review two", "review"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
      makeTask("c2", "Nested review B", "review", childOf("epic")),
      makeTask("c3", "Nested review C", "review", childOf("epic")),
    ];
    const { container } = renderBoard(tasks);
    const text = headerText(container, "review");
    const m = text.match(/^Review · (\d+)(?: \(\+(\d+) nested\))?$/);
    expect(m).not.toBeNull();
    const standalone = Number(m![1]);
    const nested = Number(m![2] ?? 0);
    expect(standalone + nested).toBe(
      tasks.filter((t) => t.status === "review").length,
    );
  });

  it("a review child nested under an in-progress parent is visibly marked review", () => {
    const { container } = renderBoard([
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
    ]);
    // The row lives inside the PARENT's card (nesting rule unchanged)…
    const inProgressCol = container.querySelector(
      '[data-column-id="in-progress"]',
    )!;
    const row = inProgressCol.querySelector(
      '[data-role="child-link-row"][data-task-id="c1"]',
    );
    expect(row).toBeInTheDocument();
    // …but carries its OWN status badge, visibly distinct from the parent.
    const badge = row!.querySelector('[data-role="child-status"]');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent("review");
    expect(badge).toHaveAttribute("data-status", "review");
    expect(badge).toHaveClass("status-badge--review");
  });
});
