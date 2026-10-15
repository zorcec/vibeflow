import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskCard, nextLaneStatus, nextLaneLabel } from "../TaskCard";
import type { Task, Column, TaskStatus } from "../../types";

/**
 * Ticket 302e9cab — "On task hover next stage".
 *
 * A hover-revealed chevron at the card's right moves the ticket to the
 * NEXT lane (backlog > todo > in-progress > review). It reuses the
 * board's existing column-drop status path (wired as `onAdvanceTask` —
 * no second write path), keeps its 22px box reserved so the card rect
 * never shifts, and stays invisible to touch pointers.
 */

function col(id: TaskStatus): Column {
  return { id, label: id, color: "#888", accent: "#888" };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-under-test",
    title: "Advance me",
    status: "todo",
    ...overrides,
  };
}

function renderCard(task: Task, status: TaskStatus, extra: object = {}) {
  return render(
    <TaskCard
      task={task}
      col={col(status)}
      allTasks={[task]}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
      {...extra}
    />,
  );
}

describe("nextLaneStatus", () => {
  it("walks backlog > todo > in-progress > review, then stops", () => {
    expect(nextLaneStatus("backlog")).toBe("todo");
    expect(nextLaneStatus("todo")).toBe("in-progress");
    expect(nextLaneStatus("in-progress")).toBe("review");
    expect(nextLaneStatus("review")).toBeNull();
    expect(nextLaneStatus("done")).toBeNull();
  });

  it("names the destination lane for the accessible label", () => {
    expect(nextLaneLabel("todo")).toBe("In Progress");
    expect(nextLaneLabel("backlog")).toBe("Todo");
    expect(nextLaneLabel("in-progress")).toBe("Review");
    expect(nextLaneLabel("review")).toBeNull();
    expect(nextLaneLabel("done")).toBeNull();
  });
});

describe("TaskCard advance control", () => {
  it("renders a labelled control pointing at the next lane", () => {
    renderCard(makeTask(), "todo", { onAdvanceTask: vi.fn() });
    const btn = screen.getByRole("button", { name: "Move to In Progress" });
    expect(btn).toHaveAttribute("data-role", "advance-task");
    expect(btn).toHaveAttribute("data-next-status", "in-progress");
  });

  it("calls the board's status path with (taskId, nextStatus) and never opens the card", () => {
    const onAdvanceTask = vi.fn();
    const onOpen = vi.fn();
    render(
      <TaskCard
        task={makeTask()}
        col={col("backlog")}
        allTasks={[makeTask()]}
        onOpen={onOpen}
        onDragStart={vi.fn()}
        onAdvanceTask={onAdvanceTask}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Move to Todo" }));
    expect(onAdvanceTask).toHaveBeenCalledTimes(1);
    expect(onAdvanceTask).toHaveBeenCalledWith("task-under-test", "todo");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders nothing on terminal lanes (review, done)", () => {
    const { container, rerender } = renderCard(makeTask(), "review", {
      onAdvanceTask: vi.fn(),
    });
    expect(
      container.querySelector('[data-role="advance-task"]'),
    ).not.toBeInTheDocument();
    rerender(
      <TaskCard
        task={makeTask()}
        col={col("done")}
        allTasks={[makeTask()]}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
        onAdvanceTask={vi.fn()}
      />,
    );
    expect(
      container.querySelector('[data-role="advance-task"]'),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when the board passes no status path (backward compatible)", () => {
    const { container } = renderCard(makeTask(), "todo");
    expect(
      container.querySelector('[data-role="advance-task"]'),
    ).not.toBeInTheDocument();
  });

  it("renders in the compact branch too", () => {
    renderCard(makeTask(), "in-progress", {
      compact: true,
      onAdvanceTask: vi.fn(),
    });
    expect(
      screen.getByRole("button", { name: "Move to Review" }),
    ).toBeInTheDocument();
  });

  it("tints the chevron with the destination lane color when provided", () => {
    renderCard(makeTask(), "todo", {
      onAdvanceTask: vi.fn(),
      advanceColor: "var(--t-accent)",
    });
    const btn = screen.getByRole("button", { name: "Move to In Progress" });
    expect(btn.getAttribute("style") ?? "").toContain("--task-advance-color");
  });

  it("is a keyboard-focusable button that cannot start a drag", () => {
    renderCard(makeTask(), "todo", { onAdvanceTask: vi.fn() });
    const btn = screen.getByRole("button", { name: "Move to In Progress" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("draggable", "false");
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });
});

const cssPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../kanban.css",
);

describe("advance control stylesheet contract", () => {
  const css = readFileSync(cssPath, "utf-8");

  it("reserves its box at rest (opacity-only reveal, never display/visibility)", () => {
    const match = css.match(/\.task-card-advance\s*\{([^}]*)\}/);
    expect(match, ".task-card-advance rule must exist").toBeTruthy();
    const block = match![1];
    expect(block).toMatch(/opacity:\s*0/);
    expect(block).toMatch(/min-width:\s*22px/);
    expect(block).toMatch(/min-height:\s*22px/);
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).not.toMatch(/visibility/);
  });

  it("reveals on card hover only for hover-capable pointers (never on touch)", () => {
    // The reveal selector must live inside a hover media gate — a bare
    // `.task-card:hover .task-card-advance` rule would sticky-reveal on
    // first tap on touch devices.
    const gated = css.match(
      /@media\s*\(hover:\s*hover\)[^{]*\{[^}]*\.task-card:hover\s+\.task-card-advance[^}]*\}/,
    );
    expect(
      gated,
      "card-hover reveal must sit inside @media (hover: hover)",
    ).toBeTruthy();
    // …and no UNGATED card-hover reveal may exist alongside it.
    const ungated = css
      .replace(/@media[^{]*\{([^{}]*\{[^}]*\}[^}]*)*\}/g, "")
      .match(/\.task-card:hover\s+\.task-card-advance/);
    expect(ungated, "no ungated card-hover reveal allowed").toBeNull();
  });

  it("stays keyboard-reachable via its own focus ring", () => {
    expect(css).toMatch(/\.task-card-advance:focus-visible\s*\{[^}]*opacity:\s*1/);
  });
});
