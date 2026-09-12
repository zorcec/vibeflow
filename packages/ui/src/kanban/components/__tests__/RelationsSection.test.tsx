import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import type { Task } from "../../types";

function makeTask(id: string, title: string, links?: Task["links"]): Task {
  return { id, title, status: "todo", links };
}

// Fresh import per test so module state is asserted cleanly
let RelationsSection: typeof import("../RelationsSection").default;

describe("RelationsSection", () => {
  // Fresh dragSession per test — resetModules gives the component its own
  // task-links instance, so the test must use that same instance.
  let dragSession: typeof import("../../task-links").dragSession;
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../RelationsSection");
    RelationsSection = mod.default;
    dragSession = (await import("../../task-links")).dragSession;
  });

  afterEach(() => dragSession.end());

  describe("empty-state first-child slot", () => {
    it("childless task renders no children group when idle", () => {
      const task = makeTask("p1", "Parent");
      render(
        <RelationsSection
          task={task}
          allTasks={[task]}
          onUpdateLinks={vi.fn()}
        />,
      );
      expect(
        document.querySelector('[data-role="relation-group-children"]'),
      ).toBeNull();
      expect(
        document.querySelector('[data-role="empty-child-slot"]'),
      ).toBeNull();
    });

    it("childless task renders the group + slot while a drag is active", () => {
      const task = makeTask("p1", "Parent");
      const other = makeTask("d1", "Drag");
      dragSession.begin(other.id);
      render(
        <RelationsSection
          task={task}
          allTasks={[task, other]}
          onUpdateLinks={vi.fn()}
        />,
      );
      // Fire window dragstart AFTER render so the useEffect listener is registered
      act(() => {
        window.dispatchEvent(new Event("dragstart"));
      });
      expect(
        document.querySelector('[data-role="relation-group-children"]'),
      ).not.toBeNull();
      const slot = document.querySelector('[data-role="empty-child-slot"]');
      expect(slot).not.toBeNull();
      expect(slot).toHaveAttribute("data-parent-id", "p1");
    });

    it("slot dragover surfaces a zone intent for the open task", () => {
      const task = makeTask("p1", "Parent");
      const other = makeTask("d1", "Drag");
      dragSession.begin(other.id);
      const onTreeReparent = vi.fn();
      render(
        <RelationsSection
          task={task}
          allTasks={[task, other]}
          onUpdateLinks={vi.fn()}
          onTreeReparent={onTreeReparent}
        />,
      );
      // Fire window dragstart AFTER render so the useEffect listener is registered
      act(() => {
        window.dispatchEvent(new Event("dragstart"));
      });
      const slot = document.querySelector('[data-role="empty-child-slot"]')!;
      fireEvent.dragOver(slot);
      // Intent must be latched before drop: dropping on the slot bubbles
      // to the group handler, which consumes the zone intent.
      fireEvent.drop(slot);
      expect(onTreeReparent).toHaveBeenCalledWith(other.id, "p1");
    });

    it("a drop without a latched intent still releases the drag session", () => {
      const task = makeTask("p1", "Parent");
      const other = makeTask("d1", "Drag");
      dragSession.begin(other.id);
      const { container } = render(
        <RelationsSection
          task={task}
          allTasks={[task, other]}
          onUpdateLinks={vi.fn()}
        />,
      );
      act(() => {
        window.dispatchEvent(new Event("dragstart"));
      });
      const group = container.querySelector(
        '[data-role="relation-group-children"]',
      );
      expect(group).toBeInTheDocument();
      // No dragover latched an intent → the drop changes nothing…
      fireEvent.drop(group!);
      // …but it must still release the drag session the board also reads.
      expect(dragSession.get()).toBeNull();
    });

    it("a rejected reparent still releases the drag session", () => {
      const parent = makeTask("p1", "Parent");
      const child = makeTask("c1", "Child", [{ taskId: "p1", type: "parent" }]);
      // Dragging the ancestor itself → dropping it on its own descendant is
      // rejected by canReparent.
      dragSession.begin(parent.id);
      const onTreeReparent = vi.fn();
      const { container } = render(
        <RelationsSection
          task={parent}
          allTasks={[parent, child]}
          onUpdateLinks={vi.fn()}
          onTreeReparent={onTreeReparent}
        />,
      );
      act(() => {
        window.dispatchEvent(new Event("dragstart"));
      });
      const row = container.querySelector('[data-task-id="c1"]') as HTMLElement;
      expect(row).toBeInTheDocument();
      fireEvent.dragOver(row);
      fireEvent.drop(row);
      expect(onTreeReparent).not.toHaveBeenCalled();
      expect(dragSession.get()).toBeNull();
    });
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

  describe("relation groups", () => {
    const groupOf = (kind: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        `[data-role="relation-group-${kind}"]`,
      );

    it("renders the RELATED group when `related` is the only relation (reported bug)", () => {
      const task = makeTask("p1", "Parent", [
        { taskId: "r1", type: "relates" },
      ]);
      const related = makeTask("r1", "Related task");
      render(
        <RelationsSection
          task={task}
          allTasks={[task, related]}
          onUpdateLinks={vi.fn()}
        />,
      );

      const relates = groupOf("relates");
      expect(relates).not.toBeNull();
      expect(relates!.textContent).toContain("RELATED · 1");
      expect(relates!.querySelector('[data-task-id="r1"]')).not.toBeNull();
      expect(screen.getByText("1 related")).toBeInTheDocument();
      // The three empty groups stay out of the DOM.
      expect(groupOf("children")).toBeNull();
      expect(groupOf("parent")).toBeNull();
      expect(groupOf("blocks")).toBeNull();
    });

    it("renders one group per relation type and keeps the chips in sync", () => {
      const task = makeTask("p1", "Parent", [
        { taskId: "root1", type: "parent" },
        { taskId: "b1", type: "blocks" },
        { taskId: "r1", type: "relates" },
      ]);
      const child = makeTask("c1", "Child 1", [
        { taskId: "p1", type: "parent" },
      ]);
      const root = makeTask("root1", "Root");
      const blocker = makeTask("b1", "Blocker");
      const related = makeTask("r1", "Related");
      render(
        <RelationsSection
          task={task}
          allTasks={[task, child, root, blocker, related]}
          onUpdateLinks={vi.fn()}
        />,
      );

      expect(
        groupOf("children")!.querySelector('[data-task-id="c1"]'),
      ).not.toBeNull();
      expect(groupOf("parent")!.textContent).toContain("PARENTS · 1");
      expect(groupOf("blocks")!.textContent).toContain("BLOCKS · 1");
      expect(groupOf("relates")!.textContent).toContain("RELATED · 1");
      expect(
        groupOf("parent")!.querySelector('[data-task-id="root1"]'),
      ).not.toBeNull();
      expect(
        groupOf("blocks")!.querySelector('[data-task-id="b1"]'),
      ).not.toBeNull();
      expect(
        groupOf("relates")!.querySelector('[data-task-id="r1"]'),
      ).not.toBeNull();

      // Chips mirror what is rendered.
      ["1 child", "1 parent", "1 blocks", "1 related"].forEach((label) =>
        expect(screen.getByText(label)).toBeInTheDocument(),
      );
    });

    it("renders no relation group for a task without relations", () => {
      const task = makeTask("p1", "Parent");
      const { container } = render(
        <RelationsSection
          task={task}
          allTasks={[task]}
          onUpdateLinks={vi.fn()}
        />,
      );
      expect(container.querySelectorAll(".relation-group")).toHaveLength(0);
    });

    it("unlinking a flat relation removes exactly that link", () => {
      const task = makeTask("p1", "Parent", [
        { taskId: "b1", type: "blocks" },
        { taskId: "r1", type: "relates" },
      ]);
      const blocker = makeTask("b1", "Blocker");
      const related = makeTask("r1", "Related");
      const onUpdateLinks = vi.fn();
      render(
        <RelationsSection
          task={task}
          allTasks={[task, blocker, related]}
          onUpdateLinks={onUpdateLinks}
        />,
      );

      const relates = groupOf("relates")!;
      fireEvent.click(within(relates).getByTitle("Unlink this relation"));

      // Only the relates link is dropped; the blocks link keeps its slot.
      expect(onUpdateLinks).toHaveBeenCalledWith([
        { taskId: "b1", type: "blocks" },
      ]);
    });

    it("flat groups list rows only — no recursion into the target's children", () => {
      const task = makeTask("p1", "Parent", [
        { taskId: "r1", type: "relates" },
      ]);
      const related = makeTask("r1", "Related");
      const nested = makeTask("x1", "Nested child", [
        { taskId: "r1", type: "parent" },
      ]);
      render(
        <RelationsSection
          task={task}
          allTasks={[task, related, nested]}
          onUpdateLinks={vi.fn()}
        />,
      );

      const relates = groupOf("relates")!;
      expect(
        relates.querySelectorAll("[data-role='child-link-row']"),
      ).toHaveLength(1);
      expect(within(relates).queryByText("Nested child")).toBeNull();
      // No nested subtree and no depth-limit summary line either.
      expect(
        relates.querySelector("[data-role='tree-depth-limit']"),
      ).toBeNull();
    });

    it("renders the parent type label without the direction arrow", () => {
      const task = makeTask("p1", "Parent");
      render(
        <RelationsSection
          task={task}
          allTasks={[task]}
          onUpdateLinks={vi.fn()}
        />,
      );

      // The add panel's type picker renders TYPE_LABELS.parent verbatim.
      fireEvent.click(document.querySelector('[data-role="relations-add"]')!);
      expect(screen.getByText("Child of")).toBeInTheDocument();
      expect(screen.queryByText("Child of →")).toBeNull();
    });
  });
});
