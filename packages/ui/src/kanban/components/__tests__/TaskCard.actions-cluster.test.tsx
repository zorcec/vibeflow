import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskCard } from "../TaskCard";
import type { Task, Column, TaskStatus } from "../../types";

/**
 * Ticket 37b82fba — "The action in top right should be closer, they
 * should take very little space".
 *
 * The advance chevron and the copy pill share one tight actions cluster
 * (2px) instead of inheriting the title row's 5px rhythm, so the pair
 * reads as one compact group flush right. Both buttons keep their
 * in-flow 22px boxes, so the card rect still cannot shift on hover.
 */

function col(id: TaskStatus): Column {
  return { id, label: id, color: "#888", accent: "#888" };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-under-test",
    title: "Cluster me",
    status: "todo",
    ...overrides,
  };
}

describe("TaskCard top-right actions cluster", () => {
  it("groups advance + copy in a tight pair after the title", () => {
    const { container } = render(
      <TaskCard
        task={makeTask()}
        col={col("todo")}
        allTasks={[makeTask()]}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
        onAdvanceTask={vi.fn()}
      />,
    );
    const advance = screen.getByRole("button", {
      name: "Move to In Progress",
    });
    const copy = container.querySelector(
      '[data-role="copy-id"]',
    ) as HTMLElement | null;
    expect(copy).toBeInTheDocument();
    // One shared cluster parent, tighter than the title row's 5px rhythm.
    const cluster = advance.parentElement;
    expect(cluster).toBe(copy!.parentElement);
    expect(cluster!.style.gap).toBe("2px");
    // The cluster caps the row, so the copy pill stays flush right.
    expect(cluster).toBe(cluster!.parentElement!.lastElementChild);
  });

  it("keeps both 22px hit targets in flow (no hover shift)", () => {
    const { container } = render(
      <TaskCard
        task={makeTask()}
        col={col("todo")}
        allTasks={[makeTask()]}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
        onAdvanceTask={vi.fn()}
      />,
    );
    const buttons = container.querySelectorAll(
      '[data-role="advance-task"], [data-role="copy-id"]',
    );
    expect(buttons).toHaveLength(2);
    // Both boxes are in-flow (no absolute positioning to collapse at rest).
    for (const btn of buttons) {
      expect(getComputedStyle(btn).position).not.toBe("absolute");
    }
  });
});
