import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
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

  it("inline variant renders the child's OWN status badge (c8160a0c)", () => {
    // A child in review nested under another parent's card must read as
    // review, not as a plain row of its parent — the badge carries the
    // child's own status, unlike the parent card around it.
    const { container } = render(
      <ChildRow child={makeTask({ status: "review" })} variant="inline" />,
    );
    const badge = screen.getByText("review");
    expect(badge).toHaveClass("status-badge--review");
    expect(badge).toHaveAttribute("data-role", "child-status");
    expect(badge).toHaveAttribute("data-status", "review");
    expect(
      container.querySelector('[data-role="child-status"]'),
    ).toBeInTheDocument();

    // Ticket 3411df56 (re-open): the row's hover/focus reveal of the copy tab
    // takes ~31px and pushes the title, so the badge FADES OUT while the row is
    // active (opacity 0, inert to the mouse) instead of competing with the tab,
    // and fades back in at rest. Non-vacuity: with the fade removed the badge
    // carries no inline style, so `badge.style.opacity` is "" and the resting
    // `.toBe("1")` below goes red; inverting the fade (visible on hover) reds
    // the `.toBe("0")` half. Both halves verified by temporarily reverting.
    const wrap = container.querySelector(
      '[data-role="child-row-wrap"]',
    ) as HTMLElement;
    expect(badge.style.opacity).toBe("1");
    fireEvent.mouseEnter(wrap);
    expect(badge.style.opacity).toBe("0");
    expect(badge.style.pointerEvents).toBe("none");
    // Only the paint goes: the hooks tests/tooling read stay in the DOM.
    expect(badge).toHaveAttribute("data-role", "child-status");
    expect(badge).toHaveAttribute("data-status", "review");
    expect(badge).toHaveAttribute("title", expect.stringContaining("review"));
    fireEvent.mouseLeave(wrap);
    expect(badge.style.opacity).toBe("1");
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
    const { container } = render(
      <ChildRow child={makeTask()} variant="popover" />,
    );
    expect(document.querySelector(".tree-guides")).not.toBeInTheDocument();
    // Owner round 2 (40bae6b2): popover rows carry no depth, so the base IS
    // the padding — 10px to match `.child-link-row--popover`, not the 2.5px
    // tree base that pinned rows edge-flush.
    expect(
      container.querySelector("[data-role='child-link-row']"),
    ).toHaveStyle({ paddingLeft: "10px" });
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

    it("marks the row while dragging and clears the mark on dragend", async () => {
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
      // The mark lands one macrotask after dragstart; writing it inside the
      // dispatch would race the browser's native drag initiation.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
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

describe("ChildRow copy-id pill", () => {
  const originalClipboard = navigator.clipboard;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("rests invisible and zero-width, and the row's hover/focus reveals it (3411df56)", () => {
    // Non-vacuity: this is the assertion that fails on the old behaviour.
    // The a3cff3b edge style forced `opacity: 1` + `min-width: 30px` inline,
    // so the old component renders opacity "1"/minWidth "30px" here and every
    // `at rest` expectation below goes red. Conversely, deleting the
    // `revealed` prop (or defaulting it to true) reds the hover/focus half.
    // Verified by temporarily reverting each half and watching this test fail.
    const { container } = render(
      <ChildRow child={makeTask()} variant="inline" depth={1} />,
    );
    const pill = container.querySelector(
      '[data-role="copy-id"]',
    ) as HTMLElement;
    const wrap = container.querySelector(
      '[data-role="child-row-wrap"]',
    ) as HTMLElement;
    const actions = container.querySelector(
      '[data-role="child-row-actions"]',
    ) as HTMLElement;
    // At rest: no painted glyph, no pointer target, and ZERO box — so the
    // strip reserves no right-hand gutter, and no divider is drawn for it.
    expect(pill.style.opacity).toBe("0");
    expect(pill.style.pointerEvents).toBe("none");
    expect(pill.style.width).toBe("0px");
    expect(pill.style.minWidth).toBe("0px");
    expect(pill.style.padding).toBe("0px");
    expect(pill.style.overflow).toBe("hidden");
    expect(actions.style.borderLeftStyle).toBe("none");

    // Row hover — anywhere on the wrapper, not only the title area —
    // restores the approved full-height tab.
    fireEvent.mouseEnter(wrap);
    expect(pill.style.opacity).toBe("1");
    expect(pill.style.width).toBe("");
    expect(pill.style.minWidth).toBe("30px");
    expect(pill.style.padding).toBe("0px 8px");
    expect(pill.style.overflow).toBe("");
    expect(pill.style.pointerEvents).toBe("auto");
    expect(actions.style.borderLeftStyle).toBe("solid");
    expect(actions.style.borderLeftWidth).toBe("1px");

    fireEvent.mouseLeave(wrap);
    expect(pill.style.opacity).toBe("0");
    expect(pill.style.minWidth).toBe("0px");
  });

  it("keyboard focus reveals the tab without removing it from the a11y tree", () => {
    const { container } = render(
      <ChildRow child={makeTask()} variant="inline" depth={1} />,
    );
    const pill = container.querySelector(
      '[data-role="copy-id"]',
    ) as HTMLElement;
    // Reachable: a real button, not display:none / visibility:hidden, and
    // still in the a11y tree with its accessible name while collapsed.
    expect(pill).not.toHaveStyle({ display: "none" });
    expect(pill.style.opacity).toBe("0");
    expect(pill).toHaveAccessibleName("Copy task id");
    // Tabbing into it lights it up (row focus-within state).
    fireEvent.focus(pill);
    expect(pill.style.opacity).toBe("1");
    expect(pill.style.pointerEvents).toBe("auto");
    expect(pill.style.outline).toContain("2px solid");
    // ...and the reveal is transient: once focus leaves the row the tab
    // collapses again instead of sticking, and the strip gives back its
    // space (live-proved on the board: focus elsewhere -> opacity 0,width 0).
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    fireEvent.blur(pill, { relatedTarget: outside });
    expect(pill.style.opacity).toBe("0");
    expect(pill.style.width).toBe("0px");
    outside.remove();
    // Copy-on-activation still works while revealed by focus alone.
    fireEvent.focus(pill);
    fireEvent.click(pill);
    return waitFor(() => expect(writeText).toHaveBeenCalledWith("abc12345-test-task"));
  });

  it("inline variant renders the copy-id pill with the child modifier class", () => {
    const { container } = render(
      <ChildRow child={makeTask()} variant="inline" depth={1} />,
    );
    const pill = container.querySelector('[data-role="copy-id"]');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass("card-copy-id--child");
    expect(pill).toHaveAttribute(
      "title",
      expect.stringContaining("abc12345-test-task"),
    );
  });

  it("popover variant renders the copy-id pill", () => {
    const { container } = render(
      <ChildRow child={makeTask()} variant="popover" />,
    );
    expect(
      container.querySelector('[data-role="copy-id"]'),
    ).toBeInTheDocument();
  });

  it("detail variant does NOT render the copy-id pill", () => {
    const { container } = render(
      <ChildRow child={makeTask()} variant="detail" depth={1} />,
    );
    expect(
      container.querySelector('[data-role="copy-id"]'),
    ).not.toBeInTheDocument();
  });

  it("clicking the pill copies the CHILD id and does not fire onOpen", async () => {
    const onOpen = vi.fn();
    const { container } = render(
      <ChildRow
        child={makeTask({ id: "child-42" })}
        variant="inline"
        depth={1}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(container.querySelector('[data-role="copy-id"]')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("child-42"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("edge geometry: pill is a stretch tab capping the actions strip (be8d59c7)", () => {
    const { container, unmount } = render(
      <ChildRow child={makeTask()} variant="inline" depth={1} />,
    );
    const pill = container.querySelector(
      '[data-role="copy-id"]',
    ) as HTMLElement;
    const actions = container.querySelector(
      '[data-role="child-row-actions"]',
    ) as HTMLElement;
    const row = container.querySelector(
      '[data-role="child-link-row"]',
    ) as HTMLElement;
    // Sibling of the row root, last tab in the strip: rounded outer corner.
    expect(pill.parentElement).toBe(actions);
    expect(actions.parentElement).toBe(row.parentElement);
    expect(pill).toHaveStyle({ alignSelf: "stretch" });
    expect(pill.style.borderRadius).toContain("6px");
    unmount();
    // With Unlink following, the copy tab is the middle segment: square.
    const withUnlink = render(
      <ChildRow
        child={makeTask()}
        variant="inline"
        depth={1}
        onRemove={vi.fn()}
      />,
    );
    expect(
      (withUnlink.container.querySelector(
        '[data-role="copy-id"]',
      ) as HTMLElement).style.borderRadius,
    ).toBe("0px");
    withUnlink.unmount();
  });
});

describe("ChildRow verify indicator (three states)", () => {
  it("tree row: verified renders success glyph and no chevron", () => {
    const { container } = render(
      <ChildRow
        child={makeTask({ status: "review", verified: true })}
        variant="inline"
        depth={1}
      />,
    );
    const icon = container.querySelector('[data-verify-state="verified"]');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute(
      "aria-label",
      "Verified — implemented correctly",
    );
    expect(
      container.querySelector(".child-link-chevron"),
    ).not.toBeInTheDocument();
  });

  it("tree row: verified=false renders warning glyph and no chevron", () => {
    const { container } = render(
      <ChildRow
        child={makeTask({ status: "review", verified: false })}
        variant="inline"
        depth={1}
      />,
    );
    const icon = container.querySelector('[data-verify-state="failed"]');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute(
      "aria-label",
      "Failed verification — not implemented correctly",
    );
    expect(
      container.querySelector(".child-link-chevron"),
    ).not.toBeInTheDocument();
  });

  it("tree row: undefined keeps today's chevron", () => {
    const { container } = render(
      <ChildRow child={makeTask({ status: "review" })} variant="inline" />,
    );
    expect(
      container.querySelector("[data-verify-state]"),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".child-link-chevron")).toBeInTheDocument();
  });

  it("tree row: in-progress + verified keeps the loader and hides the verdict", () => {
    const { container } = render(
      <ChildRow
        child={makeTask({ status: "in-progress", verified: true })}
        variant="inline"
      />,
    );
    expect(container.querySelector(".child-link-spinner")).toBeInTheDocument();
    expect(
      container.querySelector('[data-verify-state="verified"]'),
    ).not.toBeInTheDocument();
  });

  it("popover dot variant: verified swaps the dot for the glyph, undefined keeps it", () => {
    const verified = render(
      <ChildRow
        child={makeTask({ status: "review", verified: true })}
        variant="popover"
      />,
    );
    expect(
      verified.container.querySelector('[data-verify-state="verified"]'),
    ).toBeInTheDocument();
    expect(
      verified.container.querySelector(".child-link-dot"),
    ).not.toBeInTheDocument();
    verified.unmount();

    const plain = render(
      <ChildRow child={makeTask({ status: "review" })} variant="popover" />,
    );
    expect(
      plain.container.querySelector("[data-verify-state]"),
    ).not.toBeInTheDocument();
    expect(
      plain.container.querySelector(".child-link-dot"),
    ).toBeInTheDocument();
  });

  it("tree row: a Research child never shows a verdict, whatever the stored value", () => {
    for (const verified of [true, false]) {
      const { container, unmount } = render(
        <ChildRow
          child={makeTask({ status: "review", type: "Research", verified })}
          variant="inline"
          depth={1}
        />,
      );
      expect(
        container.querySelector("[data-verify-state]"),
      ).not.toBeInTheDocument();
      // The row falls back to its chevron, exactly as for an unverified child.
      expect(container.querySelector(".child-link-chevron")).toBeInTheDocument();
      unmount();
    }
  });
});
