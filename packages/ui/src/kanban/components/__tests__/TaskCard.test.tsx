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

/** Card wired to a parent shell that applies the persisted expandedBy update,
 *  the same round-trip the CLI kanban and web kanban perform. */
function ControlledCard({
  task,
  allTasks,
  userId = "user-1",
}: {
  task: Task;
  allTasks: Task[];
  userId?: string;
}) {
  const [current, setCurrent] = React.useState(task);
  return (
    <TaskCard
      task={current}
      col={col}
      allTasks={allTasks}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
      currentUserId={userId}
      onToggleExpanded={(_, expanded) =>
        setCurrent((prev) => ({
          ...prev,
          expandedBy: expanded ? [userId] : [],
        }))
      }
    />
  );
}

describe("TaskCard children toggle chip", () => {
  it("renders toggle chip + children zone when leaf descendants exist", () => {
    const { container } = renderCard(makeTask(), [makeTask(), child]);
    expect(
      container.querySelector('[data-role="children-toggle"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).toBeInTheDocument();
  });

  it("renders no toggle chip and no zone for childless cards", () => {
    const { container } = renderCard(makeTask(), [makeTask()]);
    expect(
      container.querySelector('[data-role="children-toggle"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).not.toBeInTheDocument();
  });

  it("click toggles the zone in both directions and keeps chip visible when expanded", () => {
    const { container } = render(
      <ControlledCard task={makeTask()} allTasks={[makeTask(), child]} />,
    );
    const chip = container.querySelector('[data-role="children-toggle"]')!;
    expect(chip).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).toHaveAttribute("data-expanded", "true");

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).toHaveAttribute("data-expanded", "false");
  });

  it("renders expanded from task.expandedBy for the current user (survives reload)", () => {
    const { container } = renderCard(
      makeTask({ expandedBy: ["user-1"] }),
      [makeTask(), child],
      { currentUserId: "user-1" },
    );
    expect(
      container.querySelector('[data-role="children-toggle"]'),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      container.querySelector('[data-role="children-block"]'),
    ).toHaveAttribute("data-expanded", "true");
  });

  it("stays collapsed when another user expanded the card", () => {
    const { container } = renderCard(
      makeTask({ expandedBy: ["user-2"] }),
      [makeTask(), child],
      { currentUserId: "user-1" },
    );
    expect(
      container.querySelector('[data-role="children-toggle"]'),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("reports the next expanded state to onToggleExpanded instead of keeping local state", () => {
    const onToggleExpanded = vi.fn();
    const { container } = renderCard(makeTask(), [makeTask(), child], {
      currentUserId: "user-1",
      onToggleExpanded,
    });
    const chip = container.querySelector('[data-role="children-toggle"]')!;
    fireEvent.click(chip);
    expect(onToggleExpanded).toHaveBeenCalledWith("parent-task-id", true);
    // Uncontrolled: without the parent applying the update nothing expands.
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("uncontrolled without currentUserId: no chip expansion state, no unread dot", () => {
    const { container } = renderCard(makeTask(), [makeTask(), child]);
    expect(screen.queryByTitle("Unread")).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-role="children-toggle"]'),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("chip click does not open the card and shows count label when collapsed", () => {
    const onOpen = vi.fn();
    const { container } = renderCard(makeTask(), [makeTask(), child], {
      onOpen,
    });
    const chip = container.querySelector('[data-role="children-toggle"]')!;
    fireEvent.click(chip);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(chip);
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
        isDragging: true,
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

  it("renders no toggle chip on compact or done cards", () => {
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
      container.querySelector('[data-role="children-toggle"]'),
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
      rerender.container.querySelector('[data-role="children-toggle"]'),
    ).not.toBeInTheDocument();
  });
});

describe("TaskCard unread dot", () => {
  it("renders the dot when the current user is not in openedBy", () => {
    renderCard(makeTask(), [makeTask()], { currentUserId: "user-1" });
    expect(screen.getByTitle("Unread")).toBeInTheDocument();
  });

  it("hides the dot once the current user opened the task", () => {
    renderCard(makeTask({ openedBy: ["user-1"] }), [makeTask()], {
      currentUserId: "user-1",
    });
    expect(screen.queryByTitle("Unread")).not.toBeInTheDocument();
  });

  it("shows the dot when openedBy only lists another user", () => {
    // Regression: the dot keyed off a localStorage value nothing ever wrote,
    // so it rendered on every card forever.
    renderCard(makeTask({ openedBy: ["user-2"] }), [makeTask()], {
      currentUserId: "user-1",
    });
    expect(screen.getByTitle("Unread")).toBeInTheDocument();
  });
});
