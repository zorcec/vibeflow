import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import "@testing-library/jest-dom";
import ChildPopover from "../ChildPopover";
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

function setViewport(w: number, h: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: w,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: h,
  });
}

/** Minimal DOMRect stand-in — the popover only reads its edges. */
function anchor(top: number, left: number): DOMRect {
  const height = 22;
  const width = 30;
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function popoverTop(): string {
  const pop = document.querySelector(
    "body > [data-role='child-popover']",
  ) as HTMLElement | null;
  if (!pop) throw new Error("child popover did not render");
  return pop.style.top;
}

describe("ChildPopover anchoring", () => {
  it("a 30-child card near the viewport bottom anchors the popover adjacent to the chip, not the viewport top", () => {
    setViewport(1280, 800);
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...makeChildren(30)];
    // Chip near the bottom-right, mirroring the reported board geometry.
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={() => {}}
        anchorRect={anchor(523, 925)}
      />,
    );
    try {
      // Rendered rows are capped at 6 + header + "…and N more" (~220px),
      // which fits below the chip: 523 + 22 + 6 = 551 (551 + 220 < 792).
      // The old full-count estimate (870px) pinned it to top: 8px.
      expect(popoverTop()).toBe("551px");
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });

  it("a chip with room below opens the popover directly under it", () => {
    setViewport(1280, 800);
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...makeChildren(30)];
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={() => {}}
        anchorRect={anchor(195, 557)}
      />,
    );
    try {
      // 195 + 22 + 6 = 223 directly below the chip.
      expect(popoverTop()).toBe("223px");
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });

  it("a 30-child card at the viewport bottom flips just above the chip (owner geometry)", () => {
    setViewport(1375, 983);
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...makeChildren(30)];
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={() => {}}
        anchorRect={anchor(793, 1149)}
      />,
    );
    try {
      // Below does not fit (821 + 220 > 975), so flip: 793 - 220 - 6 = 567
      // — adjacent above the chip, not pinned to the viewport top.
      expect(popoverTop()).toBe("567px");
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });

  it("a 2-child card estimates its small rendered height (no phantom flip)", () => {
    setViewport(1280, 800);
    const allTasks = [makeTask(PARENT_ID, "Parent"), ...makeChildren(2)];
    const { unmount } = render(
      <ChildPopover
        task={allTasks[0]}
        allTasks={allTasks}
        onOpenTask={() => {}}
        anchorRect={anchor(700, 557)}
      />,
    );
    try {
      // 30 + 2*28 = 86 → 700 - 86 - 6 = 608 just above the chip.
      expect(popoverTop()).toBe("608px");
    } finally {
      unmount();
      document.body.innerHTML = "";
    }
  });
});
