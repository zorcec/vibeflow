import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChildRow } from "../ChildRow";
import { TaskCard } from "../TaskCard";
import RelationsSection from "../RelationsSection";
import type { Task, Column } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "nesting-task-id",
    title: "Nesting probe",
    status: "todo",
    ...overrides,
  };
}

const col: Column = {
  id: "todo",
  label: "Todo",
  color: "#f59e0b",
  accent: "#f59e0b",
};

const child: Task = {
  id: "nesting-child-id",
  title: "Nesting child",
  status: "review",
  links: [{ type: "parent", taskId: "nesting-task-id" }],
};

/**
 * Structural invariant (ticket cd061198): no NATIVE interactive element
 * (button / a) may descend from another native interactive element anywhere
 * in the kanban subtrees. React logs validateDOMNesting for exactly this
 * shape, and stopPropagation shims cannot make it valid HTML.
 */
function nativeNestingViolations(root: Element): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll("button, a")) {
    let p = el.parentElement;
    while (p && p !== root.parentElement) {
      if (p.tagName === "BUTTON" || p.tagName === "A") {
        out.push(
          `${el.tagName}[data-role=${el.getAttribute("data-role") || "-"}] inside ${p.tagName}[data-role=${p.getAttribute("data-role") || "-"}]`,
        );
        break;
      }
      p = p.parentElement;
    }
  }
  return out;
}

describe("ChildRow interactive nesting (cd061198)", () => {
  it("inline row with copy pill + unlink: no button/a inside button/a", () => {
    const { container } = render(
      <ChildRow
        child={makeTask()}
        variant="inline"
        depth={1}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        onRowDragStart={vi.fn()}
      />,
    );
    expect(nativeNestingViolations(container)).toEqual([]);
  });

  it("popover row with copy pill: no button/a inside button/a", () => {
    const { container } = render(
      <ChildRow child={makeTask()} variant="popover" onOpen={vi.fn()} />,
    );
    expect(nativeNestingViolations(container)).toEqual([]);
  });

  it("detail row with unlink: no button/a inside button/a", () => {
    const { container } = render(
      <ChildRow
        child={makeTask()}
        variant="detail"
        depth={1}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(nativeNestingViolations(container)).toEqual([]);
  });

  it("expanded card with inline tree: no button/a inside button/a", () => {
    const parent = makeTask({ expandedBy: ["user-1"] });
    const { container } = render(
      <TaskCard
        task={parent}
        col={col}
        allTasks={[parent, child]}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
        currentUserId="user-1"
        onToggleExpanded={vi.fn()}
        onTreeRowDragStart={vi.fn()}
        onDetach={vi.fn()}
      />,
    );
    expect(
      container.querySelector('[data-role="child-link-row"]'),
    ).toBeInTheDocument();
    expect(nativeNestingViolations(container)).toEqual([]);
  });

  it("detail panel relation groups (detail rows + unlink): no button/a inside button/a", () => {
    const parent = makeTask();
    const kid: Task = {
      id: "nesting-kid-2",
      title: "Kid two",
      status: "todo",
      links: [{ type: "parent", taskId: parent.id }],
    };
    const { container } = render(
      <RelationsSection
        task={parent}
        allTasks={[parent, kid]}
        onUpdateLinks={vi.fn()}
        onOpenTask={vi.fn()}
        onDetach={vi.fn()}
      />,
    );
    expect(
      container.querySelector('[data-role="child-link-row"]'),
    ).toBeInTheDocument();
    expect(nativeNestingViolations(container)).toEqual([]);
  });

  it("row keyboard activation: Enter and Space fire onOpen", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <ChildRow child={makeTask()} variant="inline" onOpen={onOpen} />,
    );
    const row = container.querySelector(
      '[data-role="child-link-row"]',
    ) as HTMLElement;
    // The row must be keyboard-focusable without being a native button
    // (a native button root is what created the nesting defect).
    expect(row.tagName).not.toBe("BUTTON");
    expect(row.getAttribute("tabindex") ?? row.getAttribute("tabIndex")).toBe(
      "0",
    );
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("inner copy pill still copies the child id without opening the row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    try {
      const onOpen = vi.fn();
      const { container } = render(
        <ChildRow
          child={makeTask({ id: "kb-child-7" })}
          variant="inline"
          onOpen={onOpen}
        />,
      );
      fireEvent.click(container.querySelector('[data-role="copy-id"]')!);
      await vi.waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("kb-child-7"),
      );
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it("inner unlink still fires onRemove without opening the row", () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      <ChildRow
        child={makeTask()}
        variant="inline"
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByText("Unlink"));
    expect(onRemove).toHaveBeenCalledWith("nesting-task-id");
    expect(onOpen).not.toHaveBeenCalled();
  });
});
