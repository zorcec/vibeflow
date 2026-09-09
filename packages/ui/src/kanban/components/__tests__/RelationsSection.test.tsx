import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Task } from "../../types";

function makeTask(id: string, title: string, links?: Task["links"]): Task {
  return { id, title, status: "todo", links };
}

// Fresh import per test so module state is asserted cleanly
let RelationsSection: typeof import("../RelationsSection").default;

describe("RelationsSection", () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../RelationsSection");
    RelationsSection = mod.default;
  });

  it("collapsed-always header renders summary chips for children count", () => {
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
    // No tree body and no toggle affordance in collapsed-always mode
    expect(
      screen.queryByRole("button", { name: /relations/i }),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-role="relations-area-body"]'),
    ).not.toBeInTheDocument();
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

  it("header is not a toggle: no toggle button, chevron stays collapsed", () => {
    const task = makeTask("p1", "Parent");
    const child = makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]);
    render(
      <RelationsSection
        task={task}
        allTasks={[task, child]}
        onUpdateLinks={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /relations/i }),
    ).not.toBeInTheDocument();
    const header = document.querySelector(
      '[data-role="relations-area-header"]',
    );
    expect(header).not.toBeNull();
    expect(header?.tagName).not.toBe("BUTTON");
    const chevron = header?.querySelector(".block-chevron");
    expect(chevron).not.toBeNull();
    expect(chevron).not.toHaveAttribute("data-open");
    expect(
      document.querySelector('[data-role="relations-area-body"]'),
    ).not.toBeInTheDocument();
  });

  it("stays collapsed when a different task is opened", () => {
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
    expect(screen.getByText("1 child")).toBeInTheDocument();

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
    expect(screen.getByText("1 child")).toBeInTheDocument();
    expect(
      document.querySelector('[data-role="relations-area-body"]'),
    ).not.toBeInTheDocument();
  });

  it("+ Add opens the relation search/add UI", async () => {
    const task = makeTask("p1", "Parent");
    render(
      <RelationsSection
        task={task}
        allTasks={[task]}
        onUpdateLinks={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ add/i }));
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Search by id or title..."),
      ).toBeInTheDocument();
    });
  });

  it("adding a relation calls onUpdateLinks", async () => {
    const task = makeTask("p1", "Parent");
    const other = makeTask("r1", "Related task");
    const onUpdateLinks = vi.fn();

    render(
      <RelationsSection
        task={task}
        allTasks={[task, other]}
        onUpdateLinks={onUpdateLinks}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /\+ add/i }));
    fireEvent.change(screen.getByPlaceholderText("Search by id or title..."), {
      target: { value: "Related" },
    });

    await waitFor(() => {
      expect(screen.getByText("Related task")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Related task"));
    expect(onUpdateLinks).toHaveBeenCalledWith([
      { taskId: "r1", type: "relates" },
    ]);
  });
});
