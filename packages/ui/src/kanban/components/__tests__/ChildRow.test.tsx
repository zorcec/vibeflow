import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChildRow } from "../ChildRow";
import { TREE_INDENT_PX } from "../tree-constants";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "abc12345-test-task",
    title: "Test task",
    status: "todo",
    ...overrides,
  };
}

describe("ChildRow", () => {
  it("renders status badge with correct class for each status (non-inline)", () => {
    const statuses = [
      "backlog",
      "todo",
      "in-progress",
      "review",
      "done",
    ] as const;

    for (const status of statuses) {
      const { unmount } = render(
        <ChildRow child={makeTask({ status })} variant="popover" />,
      );
      const badge = screen.getByText(status);
      expect(badge).toHaveClass(`status-badge--${status}`);
      unmount();
    }
  });

  it("detail variant renders dot+title only (no badge)", () => {
    render(<ChildRow child={makeTask({ status: "todo" })} variant="detail" />);
    expect(screen.queryByText("todo")).not.toBeInTheDocument();
    expect(screen.getByText("Test task")).toBeInTheDocument();
  });

  it("does not render status badge in inline variant", () => {
    render(<ChildRow child={makeTask({ status: "done" })} variant="inline" />);
    expect(screen.queryByText("done")).not.toBeInTheDocument();
  });

  it("does not render task ID in inline variant", () => {
    render(<ChildRow child={makeTask()} variant="inline" />);
    expect(screen.queryByText("abc12345-test-task")).not.toBeInTheDocument();
  });

  it("renders 'Unlink' text button and fires onRemove on click", () => {
    const onRemove = vi.fn();
    render(
      <ChildRow child={makeTask()} variant="inline" onRemove={onRemove} />,
    );

    const removeBtn = screen.getByText("Unlink");
    expect(removeBtn).toBeInTheDocument();
    expect(removeBtn.tagName).toBe("BUTTON");

    fireEvent.click(removeBtn);
    expect(onRemove).toHaveBeenCalledWith("abc12345-test-task");
  });

  it("Unlink button stops propagation", () => {
    const parentClick = vi.fn();
    const onRemove = vi.fn();

    render(
      <div onClick={parentClick}>
        <ChildRow child={makeTask()} variant="inline" onRemove={onRemove} />
      </div>,
    );

    fireEvent.click(screen.getByText("Unlink"));
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("in-progress tree rows render loader instead of chevron", () => {
    const { unmount } = render(
      <ChildRow
        child={makeTask({ status: "in-progress" })}
        variant="inline"
        depth={1}
      />,
    );
    const loader = document.querySelector(".child-link-spinner");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-label", "In progress");
    expect(
      document.querySelector(".child-link-chevron"),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".child-link-dot")).not.toBeInTheDocument();
    unmount();
  });

  it("tree variants render status-colored chevron, no dot", () => {
    const { unmount } = render(
      <ChildRow child={makeTask({ status: "todo" })} variant="inline" />,
    );
    const chevron = document.querySelector(".child-link-chevron");
    expect(chevron).toBeInTheDocument();
    expect(chevron!.textContent).toBe("›");
    expect(document.querySelector(".child-link-dot")).not.toBeInTheDocument();
    unmount();

    render(
      <ChildRow
        child={makeTask({ status: "done" })}
        variant="detail"
        depth={2}
      />,
    );
    const chevron2 = document.querySelector(".child-link-chevron");
    expect(chevron2).toBeInTheDocument();
    expect(document.querySelector(".child-link-dot")).not.toBeInTheDocument();
  });

  it("popover retains dot, renders no chevron", () => {
    render(<ChildRow child={makeTask()} variant="popover" />);
    expect(document.querySelector(".child-link-dot")).toBeInTheDocument();
    expect(
      document.querySelector(".child-link-chevron"),
    ).not.toBeInTheDocument();
  });

  it("renders no guide lines at any depth, indents via flat left padding", () => {
    const base = 2; // minimal (inline/detail) base row padding
    const { container, unmount } = render(
      <ChildRow child={makeTask()} variant="inline" depth={1} />,
    );
    const row = container.querySelector("[data-role='child-link-row']");
    expect(document.querySelector(".tree-guides")).not.toBeInTheDocument();
    expect(document.querySelector(".tree-guide")).not.toBeInTheDocument();
    expect(document.querySelector(".tree-guide--last")).not.toBeInTheDocument();
    // Inline (card tree) root row — base padding only, no nesting step.
    expect(row).toHaveStyle({ paddingLeft: `${base}px` });
    unmount();

    // Each level below the root adds exactly one TREE_INDENT_PX step.
    const nested = render(
      <ChildRow child={makeTask()} variant="inline" depth={3} />,
    );
    expect(
      nested.container.querySelector("[data-role='child-link-row']"),
    ).toHaveStyle({ paddingLeft: `${base + 2 * TREE_INDENT_PX}px` });
    nested.unmount();

    // Detail-panel rows keep the root step so they align under the
    // relation-group label (dot + gap = one step).
    const detail = render(
      <ChildRow child={makeTask()} variant="detail" depth={3} />,
    );
    expect(
      detail.container.querySelector("[data-role='child-link-row']"),
    ).toHaveStyle({ paddingLeft: `${base + 3 * TREE_INDENT_PX}px` });
  });

  it("renders no guides when depth is absent (popover)", () => {
    render(<ChildRow child={makeTask()} variant="popover" />);
    expect(document.querySelector(".tree-guides")).not.toBeInTheDocument();
  });

  it("title has ellipsis class inside child-link-info", () => {
    render(<ChildRow child={makeTask()} variant="inline" />);
    const title = document.querySelector(".child-link-title");
    expect(title).toBeInTheDocument();
    expect(title!.textContent).toBe("Test task");
  });

  it("does not render Unlink button when onRemove is not provided", () => {
    render(<ChildRow child={makeTask()} variant="inline" />);
    expect(screen.queryByText("Remove")).not.toBeInTheDocument();
  });

  describe("row as drag source", () => {
    function dragRow() {
      const row = document.querySelector(
        "[data-role='child-link-row']",
      ) as HTMLElement;
      expect(row).toHaveAttribute("draggable", "true");
      return row;
    }

    it("registers the drag source even when no dataTransfer is available", () => {
      const onRowDragStart = vi.fn();
      render(
        <ChildRow
          child={makeTask()}
          variant="inline"
          onRowDragStart={onRowDragStart}
        />,
      );
      const row = dragRow();
      // jsdom exposes no DataTransfer at all — the drag source must still be
      // registered, otherwise the board never learns what is being dragged.
      expect(() => fireEvent.dragStart(row)).not.toThrow();
      expect(onRowDragStart).toHaveBeenCalledWith(
        expect.anything(),
        "abc12345-test-task",
      );
    });

    it("marks the row while dragging and clears the mark on dragend", () => {
      render(
        <ChildRow
          child={makeTask()}
          variant="inline"
          onRowDragStart={vi.fn()}
        />,
      );
      const row = dragRow();
      expect(row.classList.contains("dragging")).toBe(false);
      fireEvent.dragStart(row);
      expect(row.classList.contains("dragging")).toBe(true);
      fireEvent.dragEnd(row);
      expect(row.classList.contains("dragging")).toBe(false);
    });

    it("hands the id to dataTransfer as well when one exists", () => {
      const onRowDragStart = vi.fn();
      const setData = vi.fn();
      render(
        <ChildRow
          child={makeTask()}
          variant="inline"
          onRowDragStart={onRowDragStart}
        />,
      );
      fireEvent.dragStart(dragRow(), {
        dataTransfer: { setData, getData: vi.fn(() => ""), effectAllowed: "" },
      });
      expect(setData).toHaveBeenCalledWith("text/plain", "abc12345-test-task");
      expect(onRowDragStart).toHaveBeenCalled();
    });

    it("is not draggable without an onRowDragStart hook", () => {
      render(<ChildRow child={makeTask()} variant="inline" />);
      const row = document.querySelector(
        "[data-role='child-link-row']",
      ) as HTMLElement;
      expect(row).not.toHaveAttribute("draggable", "true");
    });
  });
});
