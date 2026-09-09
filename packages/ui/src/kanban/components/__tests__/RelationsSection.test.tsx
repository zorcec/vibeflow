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

  it("header renders summary chips plus the always-visible children tree", () => {
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
    // Children tree is always rendered — chevron + title rows, flat indent
    const group = document.querySelector(
      '[data-role="relation-group-children"]',
    );
    expect(group).not.toBeNull();
    expect(screen.getByText("Child 1")).toBeInTheDocument();
    expect(group!.querySelector("[data-role='child-link-row']")).not.toBeNull();
    expect(group!.querySelector(".child-link-chevron")).not.toBeNull();
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

  it("header is not a toggle: no toggle button, zero chevrons", () => {
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
    // No collapse affordance anywhere in the section
    expect(header?.querySelector(".block-chevron")).toBeNull();
    expect(
      document.querySelector('[data-role="relations-area-toggle"]'),
    ).toBeNull();
    // ...but the children group stays visible
    expect(
      document.querySelector('[data-role="relation-group-children"]'),
    ).not.toBeNull();
  });

  it("tree follows the opened task (no collapsed state persists)", () => {
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
    expect(screen.getByText("Child 1")).toBeInTheDocument();

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
    expect(screen.getByText("Child 2")).toBeInTheDocument();
    expect(screen.queryByText("Child 1")).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-role="relation-group-children"]'),
    ).not.toBeNull();
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
