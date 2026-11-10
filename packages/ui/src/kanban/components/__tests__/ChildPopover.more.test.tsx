import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import ChildPopover from "../ChildPopover";
import {
  SCROLL_RELATIONS_EVENT,
  consumeRelationsScroll,
} from "../detail-panel-scroll";
import type { Task } from "../../types";

const PARENT_ID = "parent-0001-task";

function makeTask(id: string, title: string, links: Task["links"] = []): Task {
  return { id, title, status: "todo", links } as Task;
}

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: h,
  });
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

function moreButton(): HTMLElement | null {
  return document.querySelector(
    "body > [data-role='child-popover'] [data-role='child-popover-more']",
  ) as HTMLElement | null;
}

describe("ChildPopover +N more affordance", () => {
  it("is a keyboard-reachable button whose accessible name carries the remainder", () => {
    setViewport(1280, 800);
    // 42 children → 30 shown, 12 remain.
    const withLinks: Task[] = [];
    for (let i = 0; i < 42; i++)
      withLinks.push(
        makeTask(`k-${i}`, `Kid ${i}`, [
          { taskId: PARENT_ID, type: "parent" as const },
        ]),
      );
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...withLinks];
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={() => {}}
        anchorRect={anchor()}
      />,
    );
    try {
      const more = moreButton();
      expect(more).not.toBeNull();
      expect(more!.tagName).toBe("BUTTON");
      expect(more).toHaveTextContent("+12 more");
      // Accessible name carries the count — the screen-reader announcement.
      expect(more).toHaveAccessibleName(/12 more children/);
      // Keyboard reachable: native button, no tabindex removal.
      expect(more!.hasAttribute("tabindex")).toBe(false);
      more!.focus();
      expect(document.activeElement).toBe(more);
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });

  it("click opens the PARENT task in details and arms the scroll-to-children intent", () => {
    setViewport(1280, 800);
    // 42 children → 30 shown, 12 remain.
    const kids: Task[] = [];
    for (let i = 0; i < 42; i++)
      kids.push(
        makeTask(`k-${i}`, `Kid ${i}`, [
          { taskId: PARENT_ID, type: "parent" },
        ]),
      );
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...kids];
    const onOpenTask = vi.fn();
    const seen: string[] = [];
    const onEvent = (e: Event) =>
      seen.push((e as CustomEvent<{ taskId: string }>).detail.taskId);
    document.addEventListener(SCROLL_RELATIONS_EVENT, onEvent);
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={onOpenTask}
        anchorRect={anchor()}
      />,
    );
    try {
      fireEvent.click(moreButton()!);
      // Reuses the existing open path: parent task, details tab.
      expect(onOpenTask).toHaveBeenCalledTimes(1);
      expect(onOpenTask.mock.calls[0][0]).toBe(allTasks[0]);
      expect(onOpenTask.mock.calls[0][1]).toBe("details");
      // The fresh panel consumes this exactly once on open.
      expect(consumeRelationsScroll(PARENT_ID)).toBe(true);
      expect(consumeRelationsScroll(PARENT_ID)).toBe(false);
      // And a live panel on the same task scrolls on the event.
      expect(seen).toEqual([PARENT_ID]);
    } finally {
      document.removeEventListener(SCROLL_RELATIONS_EVENT, onEvent);
      unmount();
      document.body.innerHTML = "";
    }
  });

  it("Enter on the focused affordance fires the same open", () => {
    setViewport(1280, 800);
    const kids: Task[] = [];
    for (let i = 0; i < 35; i++)
      kids.push(
        makeTask(`e-${i}`, `Kid ${i}`, [
          { taskId: PARENT_ID, type: "parent" },
        ]),
      );
    // 35 children → 30 shown, 5 remain.
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...kids];
    const onOpenTask = vi.fn();
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={onOpenTask}
        anchorRect={anchor()}
      />,
    );
    try {
      const more = moreButton()!;
      more.focus();
      fireEvent.keyDown(more, { key: "Enter", code: "Enter" });
      // Native button activation goes through click — keyDown alone must not
      // double-fire, and the click path owns the open.
      expect(onOpenTask).not.toHaveBeenCalled();
      fireEvent.click(more);
      expect(onOpenTask).toHaveBeenCalledTimes(1);
      // Drain the armed intent so no test leaks it to a later suite.
      expect(consumeRelationsScroll(PARENT_ID)).toBe(true);
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });
});
