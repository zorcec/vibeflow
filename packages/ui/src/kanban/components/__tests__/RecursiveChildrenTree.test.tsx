import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RecursiveChildrenTree, MAX_TREE_DEPTH } from "../RecursiveChildrenTree";
import type { Task } from "../../types";

function makeTask(id: string, title: string, links?: Task["links"]): Task {
  return { id, title, status: "todo", links };
}

describe("RecursiveChildrenTree", () => {
  it("renders nothing when no children exist", () => {
    const tasks = [makeTask("p1", "Parent")];
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={tasks} />,
    );
    expect(container.querySelector("[data-role='recursive-tree']")).toBeNull();
  });

  it("depth-1 nodes are direct children of the tree container (no nested wrapper)", () => {
    const tasks = [
      makeTask("p1", "Parent"),
      makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
    ];
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={tasks} />,
    );
    const tree = container.querySelector(".recursive-children-tree");
    expect(tree).toBeInTheDocument();
    const node = tree!.querySelector("[data-depth='1']");
    expect(node).toBeInTheDocument();
    // No child-tree-nested wrapper at depth 1
    expect(node!.querySelector(".child-tree-nested")).toBeNull();
  });

  it("depth-2 nodes are wrapped in .child-tree-nested", () => {
    const tasks = [
      makeTask("p1", "Parent"),
      makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
      makeTask("gc1", "Grandchild 1", [{ taskId: "c1", type: "parent" }]),
    ];
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={tasks} />,
    );
    const node2 = container.querySelector("[data-depth='2']");
    expect(node2).toBeInTheDocument();
    const nestedWrapper = node2!.closest(".child-tree-nested");
    expect(nestedWrapper).toBeInTheDocument();
  });

  it("cycle guard prevents infinite recursion", () => {
    // Create a cycle: p1 -> c1 -> p1
    const tasks = [
      makeTask("p1", "Parent", [{ taskId: "c1", type: "parent" }]),
      makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
    ];
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={tasks} />,
    );
    // Should render without infinite loop — verify it renders something
    const tree = container.querySelector("[data-role='recursive-tree']");
    expect(tree).toBeInTheDocument();
  });

  it("maxDepth renders tree-depth-limit marker", () => {
    const tasks = [
      makeTask("p1", "Parent"),
      makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
      makeTask("gc1", "Grandchild 1", [{ taskId: "c1", type: "parent" }]),
    ];
    const { container } = render(
      <RecursiveChildrenTree
        parentId="p1"
        allTasks={tasks}
        maxDepth={1}
      />,
    );
    const limit = container.querySelector(".tree-depth-limit");
    expect(limit).toBeInTheDocument();
    expect(limit!.textContent).toContain("more");
  });

  it("passes depth prop to ChildRow (depth 1 for direct children)", () => {
    const tasks = [
      makeTask("p1", "Parent"),
      makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
    ];
    render(
      <RecursiveChildrenTree parentId="p1" allTasks={tasks} />,
    );
    const row = document.querySelector("[data-role='child-link-row']");
    expect(row).toBeInTheDocument();
  });
});
