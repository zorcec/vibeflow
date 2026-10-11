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

/**
 * Sibling-actions structure (ticket be8d59c7): the copy affordance is a
 * full-height segment at the row's RIGHT edge, and the row root plus the
 * right-side controls are SIBLINGS inside .child-row-wrap — so no
 * interactive element nests inside another, neither native button-in-button
 * nor button-inside-div[role=button] (the residual: 32 buttons still
 * descended from a role=button element).
 */
function roleButtonViolations(root: Element): string[] {
  const out: string[] = [];
  for (const host of root.querySelectorAll('[role="button"]')) {
    for (const el of host.querySelectorAll("button, a")) {
      out.push(
        `${el.tagName}[data-role=${el.getAttribute("data-role") || "-"}] inside role=button[data-role=${host.getAttribute("data-role") || "-"}]`,
      );
    }
  }
  return out;
}

describe("ChildRow sibling actions structure (be8d59c7)", () => {
  it("row root and actions strip are siblings inside the wrapper", () => {
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
    const wrap = container.querySelector('[data-role="child-row-wrap"]');
    const row = container.querySelector('[data-role="child-link-row"]');
    const actions = container.querySelector('[data-role="child-row-actions"]');
    expect(wrap).toBeInTheDocument();
    expect(row?.parentElement).toBe(wrap);
    expect(actions?.parentElement).toBe(wrap);
    // Row first, actions cap the right edge.
    expect(Array.from(wrap!.children).indexOf(row!)).toBeLessThan(
      Array.from(wrap!.children).indexOf(actions!),
    );
    expect(actions).toContainElement(
      container.querySelector('[data-role="copy-id"]')!,
    );
    expect(actions).toContainElement(screen.getByText("Unlink"));
  });

  it("no button/a descends from any role=button: inline + popover + detail", () => {
    const inline = render(
      <ChildRow
        child={makeTask()}
        variant="inline"
        depth={1}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        onRowDragStart={vi.fn()}
      />,
    );
    expect(roleButtonViolations(inline.container)).toEqual([]);
    inline.unmount();

    const popover = render(
      <ChildRow child={makeTask()} variant="popover" onOpen={vi.fn()} />,
    );
    expect(roleButtonViolations(popover.container)).toEqual([]);
    popover.unmount();

    const detail = render(
      <ChildRow
        child={makeTask()}
        variant="detail"
        depth={1}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(roleButtonViolations(detail.container)).toEqual([]);
    detail.unmount();
  });

  it("Enter on the copy button copies without opening the row", async () => {
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
          child={makeTask({ id: "kb-sibling-3" })}
          variant="inline"
          onOpen={onOpen}
        />,
      );
      const copyBtn = container.querySelector(
        '[data-role="copy-id"]',
      ) as HTMLElement;
      // Sibling key handling: activating the button must not bubble into
      // the row root's Enter/Space handler.
      fireEvent.keyDown(copyBtn, { key: "Enter" });
      expect(onOpen).not.toHaveBeenCalled();
      fireEvent.click(copyBtn);
      await vi.waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("kb-sibling-3"),
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

  it("copy tab is a full-height stretch segment, collapsed and invisible at rest", () => {
    const { container } = render(
      <ChildRow child={makeTask()} variant="inline" onOpen={vi.fn()} />,
    );
    const copyBtn = container.querySelector(
      '[data-role="copy-id"]',
    ) as HTMLElement;
    expect(copyBtn).toHaveStyle({ alignSelf: "stretch" });
    expect(copyBtn.style.position).toBe("static");
    // Ticket 3411df56: the tab costs the row NOTHING until the row is
    // hovered/focused — zero width, invisible, not a mouse target.
    expect(copyBtn).toHaveStyle({ opacity: "0", width: "0px" });
    expect(copyBtn.style.pointerEvents).toBe("none");
  });

  it("wrapper lights on hover and reveals Unlink on keyboard focus", () => {
    const { container } = render(
      <ChildRow
        child={makeTask()}
        variant="inline"
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const wrap = container.querySelector(
      '[data-role="child-row-wrap"]',
    ) as HTMLElement;
    const unlink = screen.getByText("Unlink");
    // At rest the Unlink segment stays hidden to keep the face clean.
    expect(unlink).toHaveStyle({ opacity: "0" });
    fireEvent.mouseEnter(wrap);
    expect(wrap.style.background).toBe("var(--t-hover)");
    expect(unlink).toHaveStyle({ opacity: "1" });
    fireEvent.mouseLeave(wrap);
    // Keyboard: tabbing into the copy tab lights the strip too.
    fireEvent.focus(container.querySelector('[data-role="copy-id"]')!);
    expect(wrap.style.background).toBe("var(--t-hover)");
    expect(unlink).toHaveStyle({ opacity: "1" });
  });

  it("wrapper carries the depth dimming the stylesheet ramp used to paint", () => {
    const { container, unmount } = render(
      <ChildRow child={makeTask()} variant="inline" depth={2} />,
    );
    expect(
      (container.querySelector('[data-role="child-row-wrap"]') as HTMLElement)
        .style.opacity,
    ).toBe("0.7");
    unmount();
    const deep = render(
      <ChildRow child={makeTask()} variant="inline" depth={4} />,
    );
    expect(
      (deep.container.querySelector('[data-role="child-row-wrap"]') as HTMLElement)
        .style.opacity,
    ).toBe("0.5");
    deep.unmount();
  });

  it("row root keeps the drag-source hooks and the child status badge", () => {
    const onRowDragStart = vi.fn();
    const { container } = render(
      <ChildRow
        child={makeTask({ status: "review" })}
        variant="inline"
        depth={1}
        onRowDragStart={onRowDragStart}
      />,
    );
    const row = container.querySelector(
      "[data-role='child-link-row']",
    ) as HTMLElement;
    expect(row).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(row);
    expect(onRowDragStart).toHaveBeenCalledWith(
      expect.anything(),
      "nesting-task-id",
    );
    const badge = container.querySelector('[data-role="child-status"]');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-status", "review");
  });
});
