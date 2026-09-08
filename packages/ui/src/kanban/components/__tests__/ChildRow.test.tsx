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
  it("renders status badge with correct class for each status", () => {
    const statuses = [
      "backlog",
      "todo",
      "in-progress",
      "review",
      "done",
    ] as const;

    for (const status of statuses) {
      const { unmount } = render(
        <ChildRow child={makeTask({ status })} variant="inline" />,
      );
      const badge = screen.getByText(status);
      expect(badge).toHaveClass(`status-badge--${status}`);
      unmount();
    }
  });

  it("renders 'Remove' text button and fires onRemove on click", () => {
    const onRemove = vi.fn();
    render(
      <ChildRow
        child={makeTask()}
        variant="inline"
        onRemove={onRemove}
      />,
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
        <ChildRow
          child={makeTask()}
          variant="inline"
          onRemove={onRemove}
        />
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
