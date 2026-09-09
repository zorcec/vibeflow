import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  RecursiveChildrenTree,
  MAX_TREE_DEPTH,
} from "../RecursiveChildrenTree";
import { dragSession } from "../../task-links";
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
      <RecursiveChildrenTree parentId="p1" allTasks={tasks} maxDepth={1} />,
    );
    const limit = container.querySelector(".tree-depth-limit");
    expect(limit).toBeInTheDocument();
    expect(limit!.textContent).toContain("more");
  });

  it("renders no guide lines in any row", () => {
    const tasks = [
      makeTask("p1", "Parent"),
      makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
      makeTask("c2", "Child 2", [{ taskId: "p1", type: "parent" }]),
    ];
    const { container } = render(
      <RecursiveChildrenTree parentId="p1" allTasks={tasks} />,
    );
    const rows = container.querySelectorAll("[data-role='child-link-row']");
    expect(rows).toHaveLength(2);
    // Zero vertical guide lines anywhere — chevron+title rows only
    expect(container.querySelector(".tree-guides")).not.toBeInTheDocument();
    expect(container.querySelector(".tree-guide")).not.toBeInTheDocument();
    expect(
      container.querySelector(".tree-guide--last"),
    ).not.toBeInTheDocument();
    rows.forEach((row) => {
      expect(row.querySelector(".child-link-chevron")).toBeInTheDocument();
    });
  });

  describe("empty-state first-child slot", () => {
    afterEach(() => dragSession.end());

    it("renders no slot when idle and empty", () => {
      const tasks = [makeTask("p1", "Parent")];
      const { container } = render(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={tasks}
          onTreeIntent={vi.fn()}
        />,
      );
      expect(
        container.querySelector("[data-role='empty-child-slot']"),
      ).toBeNull();
    });

    it("renders the slot when a drag session is active and empty", () => {
      const tasks = [makeTask("p1", "Parent"), makeTask("d1", "Drag")];
      dragSession.begin("d1");
      const { container } = render(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={tasks}
          onTreeIntent={vi.fn()}
        />,
      );
      const slot = container.querySelector("[data-role='empty-child-slot']");
      expect(slot).toBeInTheDocument();
      expect(slot).toHaveAttribute("data-parent-id", "p1");
      expect(slot!.textContent).toMatch(/first child/i);
    });

    it("renders rows (no slot) when dragging but children exist", () => {
      const tasks = [
        makeTask("p1", "Parent"),
        makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
        makeTask("d1", "Drag"),
      ];
      dragSession.begin("d1");
      const { container } = render(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={tasks}
          onTreeIntent={vi.fn()}
        />,
      );
      expect(
        container.querySelectorAll("[data-role='child-link-row']"),
      ).toHaveLength(1);
      expect(
        container.querySelector("[data-role='empty-child-slot']"),
      ).toBeNull();
    });

    it("slot dragover surfaces a zone intent for its parent", () => {
      const tasks = [makeTask("p1", "Parent"), makeTask("d1", "Drag")];
      dragSession.begin("d1");
      const onTreeIntent = vi.fn();
      const { container } = render(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={tasks}
          onTreeIntent={onTreeIntent}
        />,
      );
      fireEvent.dragOver(
        container.querySelector("[data-role='empty-child-slot']")!,
      );
      expect(onTreeIntent).toHaveBeenCalledWith({
        kind: "zone",
        parentId: "p1",
      });
    });

    it("slot dragover rejects self-drops (no intent)", () => {
      const tasks = [makeTask("p1", "Parent")];
      dragSession.begin("p1");
      const onTreeIntent = vi.fn();
      const { container } = render(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={tasks}
          onTreeIntent={onTreeIntent}
        />,
      );
      fireEvent.dragOver(
        container.querySelector("[data-role='empty-child-slot']")!,
      );
      expect(onTreeIntent).not.toHaveBeenCalled();
    });

    it("empty slot → rows transition keeps hook count stable (no crash)", () => {
      const tasks = [makeTask("p1", "Parent"), makeTask("d1", "Drag")];
      dragSession.begin("d1");
      const { container, rerender } = render(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={tasks}
          onTreeIntent={vi.fn()}
        />,
      );
      expect(
        container.querySelector("[data-role='empty-child-slot']"),
      ).toBeInTheDocument();
      // First child arrives (e.g. slot drop committed) — same fiber renders
      // rows now; hook count must not change (else React #310).
      const withChild = [
        ...tasks,
        makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
      ];
      rerender(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={withChild}
          onTreeIntent={vi.fn()}
        />,
      );
      expect(
        container.querySelector("[data-role='empty-child-slot']"),
      ).toBeNull();
      expect(
        container.querySelectorAll("[data-role='child-link-row']"),
      ).toHaveLength(1);
      // And back to empty (last child unlinked) — still stable.
      rerender(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={tasks}
          onTreeIntent={vi.fn()}
        />,
      );
      expect(
        container.querySelector("[data-role='empty-child-slot']"),
      ).toBeInTheDocument();
    });

    it("slot rejects descendant drops (no intent)", () => {
      const tasks = [
        makeTask("d1", "Drag"),
        makeTask("p1", "Parent", [{ taskId: "d1", type: "parent" }]),
      ];
      dragSession.begin("d1");
      const onTreeIntent = vi.fn();
      const { container } = render(
        <RecursiveChildrenTree
          parentId="p1"
          allTasks={tasks}
          onTreeIntent={onTreeIntent}
        />,
      );
      fireEvent.dragOver(
        container.querySelector("[data-role='empty-child-slot']")!,
      );
      expect(onTreeIntent).not.toHaveBeenCalled();
    });
  });

  it("passes depth prop to ChildRow (depth 1 for direct children)", () => {
    const tasks = [
      makeTask("p1", "Parent"),
      makeTask("c1", "Child 1", [{ taskId: "p1", type: "parent" }]),
    ];
    render(<RecursiveChildrenTree parentId="p1" allTasks={tasks} />);
    const row = document.querySelector("[data-role='child-link-row']");
    expect(row).toBeInTheDocument();
  });
});
