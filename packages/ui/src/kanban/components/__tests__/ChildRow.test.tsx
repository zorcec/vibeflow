import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChildRow } from "../ChildRow";
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

  it("renders 'Remove' text button and fires onRemove on click", () => {
    const onRemove = vi.fn();
    render(
      <ChildRow child={makeTask()} variant="inline" onRemove={onRemove} />,
    );

    const removeBtn = screen.getByText("Remove");
    expect(removeBtn).toBeInTheDocument();
    expect(removeBtn.tagName).toBe("BUTTON");

    fireEvent.click(removeBtn);
    expect(onRemove).toHaveBeenCalledWith("abc12345-test-task");
  });

  it("Remove button stops propagation", () => {
    const parentClick = vi.fn();
    const onRemove = vi.fn();

    render(
      <div onClick={parentClick}>
        <ChildRow child={makeTask()} variant="inline" onRemove={onRemove} />
      </div>,
    );

    fireEvent.click(screen.getByText("Remove"));
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("depth 2+ renders hollow dot class", () => {
    const { unmount } = render(
      <ChildRow child={makeTask()} variant="inline" depth={2} />,
    );
    const dot = document.querySelector(".child-link-dot--hollow");
    expect(dot).toBeInTheDocument();
    unmount();

    // depth 1 should NOT have hollow dot
    render(<ChildRow child={makeTask()} variant="inline" depth={1} />);
    const dot2 = document.querySelector(".child-link-dot--hollow");
    expect(dot2).not.toBeInTheDocument();
  });

  it("depth 1 renders one full-height guide, no elbow", () => {
    render(
      <ChildRow child={makeTask()} variant="inline" depth={1} isLast={false} />,
    );
    const guides = document.querySelector(".tree-guides");
    expect(guides).toBeInTheDocument();
    expect(guides!.querySelectorAll(".tree-guide")).toHaveLength(1);
    expect(guides!.querySelector(".tree-guide--last")).not.toBeInTheDocument();
  });

  it("last child renders elbow on own level, full guides above", () => {
    render(<ChildRow child={makeTask()} variant="detail" depth={3} isLast />);
    const guides = document.querySelector(".tree-guides");
    expect(guides!.querySelectorAll(".tree-guide")).toHaveLength(2);
    const last = guides!.querySelectorAll(".tree-guide--last");
    expect(last).toHaveLength(1);
    // Elbow is the final slot (own level)
    expect(guides!.lastElementChild).toHaveClass("tree-guide--last");
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

  it("does not render Remove button when onRemove is not provided", () => {
    render(<ChildRow child={makeTask()} variant="inline" />);
    expect(screen.queryByText("Remove")).not.toBeInTheDocument();
  });
});
