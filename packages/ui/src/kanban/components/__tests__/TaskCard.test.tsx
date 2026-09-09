import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskCard } from "../TaskCard";
import { dragSession } from "../../task-links";
import type { Task, Column } from "../../types";

const col: Column = {
  id: "todo",
  label: "Todo",
  color: "#f59e0b",
  accent: "#f59e0b",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "parent-task-id",
    title: "Parent task",
    status: "todo",
    ...overrides,
  };
}

const child: Task = {
  id: "child-task-id",
  title: "Child task",
  status: "todo",
  links: [{ type: "parent", taskId: "parent-task-id" }],
};

function renderCard(task: Task, allTasks: Task[], extra: object = {}) {
  return render(
    <TaskCard
      task={task}
      col={col}
      allTasks={allTasks}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
      {...extra}
    />,
  );
}

describe("TaskCard bottom expand chevron", () => {
  it("renders chevron + children zone when leaf descendants exist", () => {
    const { container } = renderCard(makeTask(), [makeTask(), child]);
    expect(
      container.querySelector('[data-role="card-expand-chevron"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).toBeInTheDocument();
  });

  it("renders no chevron and no zone for childless cards", () => {
    const { container } = renderCard(makeTask(), [makeTask()]);
    expect(
      container.querySelector('[data-role="card-expand-chevron"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).not.toBeInTheDocument();
  });

  it("click toggles the zone in both directions and keeps chevron visible when expanded", () => {
    const { container } = renderCard(makeTask(), [makeTask(), child]);
    const chevron = container.querySelector(
      '[data-role="card-expand-chevron"]',
    )!;
    expect(chevron).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "true");
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).toHaveAttribute("data-expanded", "true");

    fireEvent.click(chevron);
    expect(chevron).toHaveAttribute("aria-expanded", "false");
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).toHaveAttribute("data-expanded", "false");
  });

  it("chevron click does not open the card and the ⤷N chip remains", () => {
    const onOpen = vi.fn();
    const { container } = renderCard(makeTask(), [makeTask(), child], {
      onOpen,
    });
    const chevron = container.querySelector(
      '[data-role="card-expand-chevron"]',
    )!;
    fireEvent.click(chevron);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText("⤷1")).toBeInTheDocument();
  });

  describe("empty-state first-child slot", () => {
    afterEach(() => dragSession.end());

    it("childless card renders no slot when idle", () => {
      const { container } = renderCard(makeTask(), [makeTask()]);
      expect(
        container.querySelector('[data-role="empty-child-slot"]'),
      ).not.toBeInTheDocument();
    });

    it("childless card renders the slot while a drag is active", () => {
      const other = makeTask({ id: "other-task-id", title: "Other" });
      dragSession.begin(other.id);
      const { container } = renderCard(makeTask(), [makeTask(), other], {
        onTreeIntent: vi.fn(),
      });
      const slot = container.querySelector('[data-role="empty-child-slot"]');
      expect(slot).toBeInTheDocument();
      expect(slot).toHaveAttribute("data-parent-id", "parent-task-id");
    });

    it("card with children renders rows, not the slot, while dragging", () => {
      dragSession.begin("other-task-id");
      const { container } = renderCard(makeTask(), [makeTask(), child], {
        onTreeIntent: vi.fn(),
      });
      // Zone collapsed by default; slot belongs to childless trees only
      expect(
        container.querySelector('[data-role="empty-child-slot"]'),
      ).not.toBeInTheDocument();
    });
  });

  it("renders no chevron on compact or done cards", () => {
    const doneCol: Column = {
      id: "done",
      label: "Done",
      color: "#22c55e",
      accent: "#22c55e",
    };
    const { container, unmount } = render(
      <TaskCard
        task={makeTask()}
        col={doneCol}
        allTasks={[makeTask(), child]}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
    expect(
      container.querySelector('[data-role="card-expand-chevron"]'),
    ).not.toBeInTheDocument();
    unmount();

    const rerender = render(
      <TaskCard
        task={makeTask()}
        col={col}
        compact
        allTasks={[makeTask(), child]}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
    expect(
      rerender.container.querySelector('[data-role="card-expand-chevron"]'),
    ).not.toBeInTheDocument();
  });
});
