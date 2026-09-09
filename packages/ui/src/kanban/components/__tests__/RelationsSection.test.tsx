import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Task } from "../../types";

function makeTask(id: string, title: string, links?: Task["links"]): Task {
  return { id, title, status: "todo", links };
}

// Fresh import per test so the collapsed-by-default initial state is asserted cleanly
let RelationsSection: typeof import("../RelationsSection").default;

describe("RelationsSection", () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../RelationsSection");
    RelationsSection = mod.default;
  });

  it("collapsed header renders summary chips for children count", () => {
    const task = makeTask("p1", "Parent");
    const child = makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]);
    render(
      <RelationsSection
        task={task}
        allTasks={[task, child]}
        onUpdateLinks={vi.fn()}
      />,
    );
    expect(screen.getByText("1 child")).toBeInTheDocument();
    // Body (tree) stays hidden until the user expands it
    expect(screen.queryByText("+ Add")).not.toBeInTheDocument();
  });

  it("collapsed header renders parent chips", () => {
    const task = makeTask("p1", "Parent", [
      { taskId: "root1", type: "parent" },
    ]);
    const root = makeTask("root1", "Root");
    render(
      <RelationsSection
        task={task}
        allTasks={[task, root]}
        onUpdateLinks={vi.fn()}
      />,
    );
    expect(screen.getByText("1 parent")).toBeInTheDocument();
  });

  it("re-collapses when a different task is opened", async () => {
    const task1 = makeTask("p1", "Parent 1");
    const child1 = makeTask("c1", "Child 1", [
      { taskId: "p1", type: "parent" },
    ]);
    const { rerender } = render(
      <RelationsSection
        task={task1}
        allTasks={[task1, child1]}
        onUpdateLinks={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /relations/i }));
    await waitFor(() => {
      expect(screen.getByText("+ Add")).toBeInTheDocument();
    });

    const task2 = makeTask("p2", "Parent 2");
    const child2 = makeTask("c2", "Child 2", [
      { taskId: "p2", type: "parent" },
    ]);
    rerender(
      <RelationsSection
        task={task2}
        allTasks={[task2, child2]}
        onUpdateLinks={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText("+ Add")).not.toBeInTheDocument();
    });
    expect(screen.getByText("1 child")).toBeInTheDocument();
  });

  it("clicking toggle opens body", async () => {
    const task = makeTask("p1", "Parent");
    render(
      <RelationsSection
        task={task}
        allTasks={[task]}
        onUpdateLinks={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("button", { name: /relations/i });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByText("+ Add")).toBeInTheDocument();
    });
  });

  it("RelationRow renders Remove text button", async () => {
    const task = makeTask("p1", "Parent", [{ taskId: "r1", type: "relates" }]);
    const related = makeTask("r1", "Related task");
    const onUpdateLinks = vi.fn();

    render(
      <RelationsSection
        task={task}
        allTasks={[task, related]}
        onUpdateLinks={onUpdateLinks}
      />,
    );

    // Open the section
    fireEvent.click(screen.getByRole("button", { name: /relations/i }));

    await waitFor(() => {
      expect(screen.getByText("+ Add")).toBeInTheDocument();
    });

    const removeButtons = screen.getAllByText("Remove");
    expect(removeButtons.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(removeButtons[0]);
    expect(onUpdateLinks).toHaveBeenCalled();
  });

  it("header shows chevron with data-open when expanded", async () => {
    const task = makeTask("p1", "Parent");
    render(
      <RelationsSection
        task={task}
        allTasks={[task]}
        onUpdateLinks={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("button", { name: /relations/i });
    const chevron = toggle.querySelector(".block-chevron");
    expect(chevron).not.toHaveAttribute("data-open");

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(chevron).toHaveAttribute("data-open");
    });
  });
});
