import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RecursiveChildrenTree } from "../RecursiveChildrenTree";
import type { Task } from "../../types";

function makeTask(id: string, title: string, links?: Task["links"]): Task {
  return { id, title, status: "todo", links };
}

/** parent -> child -> grandchild: two tree levels under the card. */
function nestedTasks(): Task[] {
  return [
    makeTask("p1", "Parent"),
    makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
    makeTask("gc1", "Grandchild 1", [{ taskId: "c1", type: "parent" }]),
    makeTask("c2", "Child 2 (leaf)", [{ taskId: "p1", type: "parent" }]),
  ];
}

describe("RecursiveChildrenTree per-node collapse (47df2128)", () => {
  it("expands the full subtree by default (no collapsed nodes)", () => {
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={nestedTasks()} />,
    );
    // Both depth levels render: direct children + grandchild.
    expect(container.querySelector("[data-depth='1']")).toBeInTheDocument();
    expect(container.querySelector("[data-depth='2']")).toBeInTheDocument();
    expect(container.textContent).toContain("Grandchild 1");
  });

  it("rows with children carry a collapse toggle; leaf rows do not", () => {
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={nestedTasks()} />,
    );
    const c1Toggle = container.querySelector(
      '[data-role="tree-node-toggle"][data-task-id="c1"]',
    );
    expect(c1Toggle).toBeInTheDocument();
    expect(c1Toggle).toHaveAttribute("aria-expanded", "true");
    // c2 is a leaf — no subtree to collapse, no toggle.
    expect(
      container.querySelector(
        '[data-role="tree-node-toggle"][data-task-id="c2"]',
      ),
    ).not.toBeInTheDocument();
    // gc1 is a leaf too.
    expect(
      container.querySelector(
        '[data-role="tree-node-toggle"][data-task-id="gc1"]',
      ),
    ).not.toBeInTheDocument();
  });

  it("collapsing a node hides its subtree; expanding restores it", () => {
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={nestedTasks()} />,
    );
    const toggle = container.querySelector(
      '[data-role="tree-node-toggle"][data-task-id="c1"]',
    )!;
    expect(container.querySelector("[data-depth='2']")).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The collapsed node's row stays; its subtree is gone.
    expect(
      container.querySelector('[data-task-id="c1"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector("[data-depth='2']"),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("[data-depth='2']")).toBeInTheDocument();
  });

  it("collapsing one node leaves sibling subtrees untouched", () => {
    const tasks: Task[] = [
      makeTask("p1", "Parent"),
      makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
      makeTask("gc1", "Grandchild 1", [{ taskId: "c1", type: "parent" }]),
      makeTask("c2", "Child 2", [{ taskId: "p1", type: "parent" }]),
      makeTask("gc2", "Grandchild 2", [{ taskId: "c2", type: "parent" }]),
    ];
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={tasks} />,
    );
    fireEvent.click(
      container.querySelector(
        '[data-role="tree-node-toggle"][data-task-id="c1"]',
      )!,
    );
    expect(container.textContent).not.toContain("Grandchild 1");
    expect(container.textContent).toContain("Grandchild 2");
  });

  it("toggle is keyboard-operable and does not open the child", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <RecursiveChildrenTree
        parentId="p1"
        allTasks={nestedTasks()}
        onOpen={onOpen}
      />,
    );
    const toggle = container.querySelector(
      '[data-role="tree-node-toggle"][data-task-id="c1"]',
    )!;
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("flat mode renders no toggles (no subtrees to collapse)", () => {
    const tasks = nestedTasks();
    const { container } = render(
      <RecursiveChildrenTree
        parentId="p1"
        allTasks={tasks}
        flat
        nodes={[tasks[1]]}
      />,
    );
    expect(
      container.querySelector('[data-role="tree-node-toggle"]'),
    ).not.toBeInTheDocument();
  });
});
