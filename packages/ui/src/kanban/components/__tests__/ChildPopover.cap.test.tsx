import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import ChildPopover, {
  CHILD_POPOVER_MAX_VISIBLE,
} from "../ChildPopover";
import type { Task } from "../../types";

const PARENT_ID = "parent-0001-task";

function makeTask(id: string, title: string, links: Task["links"] = []): Task {
  return { id, title, status: "todo", links } as Task;
}

function makeChildren(n: number): Task[] {
  const kids: Task[] = [];
  for (let i = 0; i < n; i++) {
    kids.push(
      makeTask(`child-${String(i).padStart(4, "0")}-task`, `Kid ${i}`, [
        { taskId: PARENT_ID, type: "parent" },
      ]),
    );
  }
  return kids;
}

function anchor(): DOMRect {
  return {
    top: 100,
    bottom: 122,
    left: 557,
    right: 587,
    width: 30,
    height: 22,
    x: 557,
    y: 100,
    toJSON: () => ({}),
  } as DOMRect;
}

function renderedRowCount(): number {
  return document.querySelectorAll(
    "body > [data-role='child-popover'] [data-role='child-link-row']",
  ).length;
}

describe("ChildPopover cap", () => {
  it("renders 30 rows when 42 children exist", () => {
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...makeChildren(42)];
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={() => {}}
        anchorRect={anchor()}
      />,
    );
    try {
      expect(CHILD_POPOVER_MAX_VISIBLE).toBe(30);
      expect(renderedRowCount()).toBe(30);
      // Header still names the full family; the truncation line the remainder.
      expect(
        document.querySelector(
          "body > [data-role='child-popover'] .child-popover-header",
        ),
      ).toHaveTextContent("42 children");
      expect(
        document.querySelector(
          "body > [data-role='child-popover'] .child-popover-more",
        ),
      ).toHaveTextContent("…and 12 more");
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });

  it("renders every row and no truncation line at exactly 30 children", () => {
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...makeChildren(30)];
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={() => {}}
        anchorRect={anchor()}
      />,
    );
    try {
      expect(renderedRowCount()).toBe(30);
      expect(
        document.querySelector(
          "body > [data-role='child-popover'] .child-popover-more",
        ),
      ).toBeNull();
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });

  it("renders every row and no truncation line below the cap", () => {
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...makeChildren(7)];
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={() => {}}
        anchorRect={anchor()}
      />,
    );
    try {
      // 7 exceeds the old cap of 6: the raise, not the truncation, owns it.
      expect(renderedRowCount()).toBe(7);
      expect(
        document.querySelector(
          "body > [data-role='child-popover'] .child-popover-more",
        ),
      ).toBeNull();
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });
});
