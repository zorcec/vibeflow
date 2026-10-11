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

/** Header count text for one column, e.g. `Review · 2` (root cards only). */
function headerText(container: HTMLElement, colId: string): string {
  const el = container.querySelector(
    `[data-column-id="${colId}"] [data-role="column-count"]`,
  );
  expect(el).toBeInTheDocument();
  return el!.textContent ?? "";
}

/** Visible nested hint chip for one column, or null when nothing is nested. */
function nestedHint(container: HTMLElement, colId: string): HTMLElement | null {
  return container.querySelector(
    `[data-column-id="${colId}"] [data-role="nested-hint"]`,
  );
}

describe("KanbanBoard root-only header count (bba8e7f9/f476bfbc)", () => {
  it("header shows the plain card count when nothing is nested", () => {
    const { container } = renderBoard([
      makeTask("r1", "Review one", "review"),
      makeTask("r2", "Review two", "review"),
      makeTask("t1", "Todo one", "todo"),
    ]);
    expect(headerText(container, "review")).toBe("Review · 2");
    // Zero nested: no hint attributes, no visible hint chip.
    const header = container.querySelector(
      '[data-column-id="review"] [data-role="column-count"]',
    )!;
    expect(header).not.toHaveTextContent("nested");
    expect(header.getAttribute("data-nested-count")).toBeNull();
    expect(header.getAttribute("title")).toBeNull();
    expect(nestedHint(container, "review")).toBeNull();
  });

  it("header shows ONLY the root count when children carry the column status", () => {
    const tasks = [
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("r1", "Review one", "review"),
      makeTask("r2", "Review two", "review"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
      makeTask("c2", "Nested review B", "review", childOf("epic")),
      makeTask("c3", "Nested review C", "review", childOf("epic")),
    ];
    const { container } = renderBoard(tasks);
    // THE NEW CONTRACT: visible header is the root-card count only.
    expect(headerText(container, "review")).toBe("Review · 2");
    // The parent's own column is unaffected — no nested in-progress tasks.
    expect(headerText(container, "in-progress")).toBe("In Progress · 1");
  });

  it("the old (+N nested) suffix never appears in the visible header text", () => {
    const tasks = [
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("r1", "Review one", "review"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
      makeTask("c2", "Nested review B", "review", childOf("epic")),
    ];
    const { container } = renderBoard(tasks);
    // NON-VACUOUS regression guard: fails if the old suffix comes back.
    // The visible count must be exactly `Label · N` with nothing appended.
    expect(headerText(container, "review")).toMatch(/^Review · \d+$/);
    expect(headerText(container, "review")).not.toContain("nested");
    expect(headerText(container, "review")).not.toContain("(");
  });

  it("a visible nested hint chip discloses the hidden tasks", () => {
    const { container } = renderBoard([
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("r1", "Review one", "review"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
    ]);
    const hint = nestedHint(container, "review");
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent("1 nested");
    expect(hint!.getAttribute("data-nested-count")).toBe("1");
    // Accessible affordance: hover title + aria-label state the breakdown.
    expect(hint!.getAttribute("title")).toContain("nested inside parent cards");
    expect(hint!.getAttribute("aria-label")).toContain("1 tasks");
    // Columns with nothing nested render no chip at all.
    expect(nestedHint(container, "in-progress")).toBeNull();
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

  it("visible root count + hint reconciles with every task carrying the status", () => {
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
    const m = text.match(/^Review · (\d+)$/);
    expect(m).not.toBeNull();
    const standalone = Number(m![1]);
    const hint = nestedHint(container, "review")!;
    expect(hint).toBeInTheDocument();
    const nested = Number(hint.getAttribute("data-nested-count"));
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
