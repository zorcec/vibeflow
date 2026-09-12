import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Task, TaskLinkType } from "../../types";

/**
 * Regression: the flat relation groups in the task-details Relations area
 * (PARENTS / BLOCKS / RELATED) rendered their rows as inert buttons — no
 * `draggable`, no `dragSession` entry — while every other task row in the app
 * (board cards, card inline trees, the CHILDREN group) was a working drag
 * source. Task 9cd3f4bb was the only task in the store whose only relation is
 * `related`, so it was the only one where every relation row was dead; the
 * report was "drag and drop works for all items except this one".
 *
 * Root cause: `RecursiveChildrenTree` gated the row drag *source* wiring on
 * `dndActive = Boolean(onTreeIntent)` — the same flag that decides whether the
 * tree accepts drop *intents*. The flat groups deliberately pass no drop intent,
 * so they silently lost the drag source too.
 */

function makeTask(id: string, title: string, links?: Task["links"]): Task {
  return { id, title, status: "todo", links };
}

function dataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(() => ""), effectAllowed: "none" };
}

function rowFor(taskId: string): HTMLElement | null {
  return document.querySelector(
    `[data-role="child-link-row"][data-task-id="${taskId}"]`,
  );
}

// Fresh import per test: dragSession is a module singleton, and the test must
// read the same instance the component writes to.
let RelationsSection: typeof import("../RelationsSection").default;
let RecursiveChildrenTree: typeof import("../RecursiveChildrenTree").RecursiveChildrenTree;
let dragSession: typeof import("../../task-links").dragSession;

beforeEach(async () => {
  vi.resetModules();
  RelationsSection = (await import("../RelationsSection")).default;
  RecursiveChildrenTree = (await import("../RecursiveChildrenTree"))
    .RecursiveChildrenTree;
  dragSession = (await import("../../task-links")).dragSession;
});

afterEach(() => dragSession.end());

describe("relation rows are drag sources", () => {
  const FLAT_GROUPS: Array<{
    type: TaskLinkType;
    group: string;
    label: string;
  }> = [
    { type: "relates", group: "relation-group-relates", label: "RELATED" },
    { type: "parent", group: "relation-group-parent", label: "PARENTS" },
    { type: "blocks", group: "relation-group-blocks", label: "BLOCKS" },
  ];

  it.each(FLAT_GROUPS)(
    "the $label row starts a drag and registers the drag session",
    ({ type, group, label }) => {
      // The task owns the relation; the row renders the *other* task.
      const task = makeTask("p1", "Open task", [{ taskId: "r1", type }]);
      const related = makeTask("r1", "Related task");

      render(
        <RelationsSection
          task={task}
          allTasks={[task, related]}
          onUpdateLinks={vi.fn()}
        />,
      );

      const groupEl = document.querySelector(`[data-role="${group}"]`);
      expect(groupEl).not.toBeNull();
      expect(groupEl!.textContent).toContain(label);

      const row = rowFor("r1");
      expect(row).not.toBeNull();
      expect(row).toHaveAttribute("draggable", "true");

      const dt = dataTransfer();
      fireEvent.dragStart(row!, { dataTransfer: dt });

      // The tree always begins the drag session itself — a session-only
      // source is how the board resolves drags that start outside its columns.
      expect(dragSession.get()).toBe("r1");
      expect(dt.setData).toHaveBeenCalledWith("text/plain", "r1");
    },
  );

  it.each(FLAT_GROUPS)(
    "the $label row is not a drop target (reparent stays inside the CHILDREN tree)",
    ({ type, group }) => {
      const task = makeTask("p1", "Open task", [{ taskId: "r1", type }]);
      const related = makeTask("r1", "Related task");

      render(
        <RelationsSection
          task={task}
          allTasks={[task, related]}
          onUpdateLinks={vi.fn()}
        />,
      );

      dragSession.begin("other");
      const row = rowFor("r1");
      fireEvent.dragOver(row!, { clientY: 5 });
      fireEvent.drop(row!);

      // No insertion line, no row highlight, no children-zone intent.
      const groupEl = document.querySelector(`[data-role="${group}"]`)!;
      expect(groupEl.querySelector('[data-role="tree-drop-line"]')).toBeNull();
      expect(groupEl.querySelector(".tree-node--drop-target")).toBeNull();
      expect(row).not.toHaveAttribute("data-drop-target");
      expect(
        document.querySelector('[data-role="empty-child-slot"]'),
      ).toBeNull();
    },
  );

  it("an explicit-nodes (flat) tree renders rows as drag sources without a drop intent", () => {
    const nodes = [makeTask("r1", "Related task")];
    render(
      <RecursiveChildrenTree
        parentId="p1"
        allTasks={nodes}
        nodes={nodes}
        flat
        variant="detail"
      />,
    );

    const row = rowFor("r1");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("draggable", "true");

    const dt = dataTransfer();
    fireEvent.dragStart(row!, { dataTransfer: dt });
    expect(dragSession.get()).toBe("r1");
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "r1");
  });
});
