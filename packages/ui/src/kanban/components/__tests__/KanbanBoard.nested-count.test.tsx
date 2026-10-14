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

describe("KanbanBoard header child counts (f2bef66a)", () => {
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

  it("owner example: a parent in review with 3 children renders Review 1 + ↳ 3", () => {
    const { container } = renderBoard([
      makeTask("epic", "Epic parent", "review"),
      makeTask("c1", "Child todo", "todo", childOf("epic")),
      makeTask("c2", "Child done", "done", childOf("epic")),
      makeTask("c3", "Child review", "review", childOf("epic")),
    ]);
    // THE NEW CONTRACT: the visible header is the root-card count, and the
    // hint accounts for the column's OWNED children — regardless of status.
    expect(headerText(container, "review")).toBe("Review · 1");
    const hint = nestedHint(container, "review")!;
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent("↳ 3");
    expect(hint.getAttribute("data-nested-count")).toBe("3");
  });

  it("children count in the parent's column, never in their own status column", () => {
    const { container } = renderBoard([
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("r1", "Review one", "review"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
      makeTask("c2", "Nested review B", "review", childOf("epic")),
    ]);
    // The review children render inside the in-progress card, so the
    // in-progress header owns them; the review header stays hint-free.
    expect(headerText(container, "review")).toBe("Review · 1");
    expect(nestedHint(container, "review")).toBeNull();
    expect(headerText(container, "in-progress")).toBe("In Progress · 1");
    expect(nestedHint(container, "in-progress")).toHaveTextContent("↳ 2");
  });

  it("the old status-based (+N nested elsewhere) hint never appears", () => {
    const { container } = renderBoard([
      makeTask("epic", "Epic parent", "in-progress"),
      makeTask("r1", "Review one", "review"),
      makeTask("c1", "Nested review A", "review", childOf("epic")),
      makeTask("c2", "Nested review B", "review", childOf("epic")),
    ]);
    // NON-VACUOUS regression guard: the review column must NOT disclose
    // children owned by another column, and the visible count stays exactly
    // `Label · N` with nothing appended.
    expect(headerText(container, "review")).toMatch(/^Review · \d+$/);
    expect(headerText(container, "review")).not.toContain("nested");
    expect(headerText(container, "review")).not.toContain("(");
    const header = container.querySelector(
      '[data-column-id="review"] [data-role="column-count"]',
    )!;
    expect(header.getAttribute("data-nested-count")).toBeNull();
    expect(header.getAttribute("title")).toBeNull();
  });

  it("the nested hint carries no pill chrome — bare faint text only (93f10f06)", () => {
    // NON-VACUOUS guard for the owner's "make it very minimal" ask: this
    // fails if the bordered/filled pill comes back. The chip's box is drawn
    // with inline styles, so asserting them here is the real contract.
    const { container } = renderBoard([
      makeTask("epic", "Epic parent", "review"),
      makeTask("c1", "Child A", "todo", childOf("epic")),
    ]);
    const hint = nestedHint(container, "review")!;
    expect(hint).toHaveTextContent("↳ 1");
    expect(hint).not.toHaveTextContent(/nested/i);
    expect(hint.style.border).toBe("");
    expect(hint.style.borderRadius).toBe("");
    expect(hint.style.padding).toBe("");
    expect(hint.style.background).toBe("");
    // Size/colour survive: 10px faint text, right after the count.
    expect(hint.style.fontSize).toBe("10px");
    expect(hint.style.color).toBe("var(--t-text-faint)");
  });

  it("the owned-child count is reachable via hover title on the header", () => {
    const { container } = renderBoard([
      makeTask("epic", "Epic parent", "review"),
      makeTask("c1", "Child todo", "todo", childOf("epic")),
    ]);
    const header = container.querySelector(
      '[data-column-id="review"] [data-role="column-count"]',
    )!;
    expect(header.getAttribute("data-nested-count")).toBe("1");
    // The title states the full breakdown: total, cards, and owned nested.
    expect(header.getAttribute("title")).toBe(
      "2 tasks in Review: 1 shown as cards, 1 nested inside parent cards in this column",
    );
    const hint = nestedHint(container, "review")!;
    expect(hint.getAttribute("aria-label")).toContain(
      "nested inside parent cards in this column",
    );
  });

  it("visible root count + hint reconciles with the column's rendered rows", () => {
    const tasks = [
      makeTask("epic", "Epic parent", "review"),
      makeTask("c1", "Child todo", "todo", childOf("epic")),
      makeTask("c2", "Child done", "done", childOf("epic")),
      makeTask("c3", "Child review", "review", childOf("epic")),
    ];
    const { container } = renderBoard(tasks);
    const text = headerText(container, "review");
    const m = text.match(/^Review · (\d+)$/);
    expect(m).not.toBeNull();
    const standalone = Number(m![1]);
    const hint = nestedHint(container, "review")!;
    expect(hint).toBeInTheDocument();
    const nested = Number(hint.getAttribute("data-nested-count"));
    // Cards + owned descendants = every task in the column's rendered tree.
    expect(standalone + nested).toBe(tasks.length);
    expect(standalone).toBe(1);
    expect(nested).toBe(3);
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
