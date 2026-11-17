import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskCard, CardTitle, isTitleTruncated } from "../TaskCard";
import type { Task, Column } from "../../types";

const LONG_TITLE =
  "Research: republishing — where to publish copies, the canonical ordering rule, and how far automation genuinely goes";

const col: Column = {
  id: "todo",
  label: "Todo",
  color: "#f59e0b",
  accent: "#f59e0b",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-id",
    title: LONG_TITLE,
    status: "todo",
    ...overrides,
  };
}

function renderCard(task: Task) {
  return render(
    <TaskCard
      task={task}
      col={col}
      allTasks={[task]}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
    />,
  );
}

/** Script the layout numbers jsdom cannot compute (all widths are 0 there). */
function mockTruncation(
  scrollWidth: number,
  clientWidth: number,
  scrollHeight = 0,
  clientHeight = 0,
) {
  const el = screen.getByText(LONG_TITLE, {
    selector: '[data-role="card-title"]',
  }) as HTMLElement;
  Object.defineProperty(el, "scrollWidth", {
    value: scrollWidth,
    configurable: true,
  });
  Object.defineProperty(el, "clientWidth", {
    value: clientWidth,
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  return el;
}

function hoverTitle() {
  const title = screen.getByText(LONG_TITLE, {
    selector: '[data-role="card-title"]',
  }) as HTMLElement;
  fireEvent.mouseEnter(title);
  return title;
}

describe("isTitleTruncated (0614a29e)", () => {
  it("reports truncated when content overflows the box", () => {
    expect(isTitleTruncated(668, 211)).toBe(true);
  });
  it("reports fitting when content matches the box exactly", () => {
    expect(isTitleTruncated(211, 211)).toBe(false);
  });
  it("ignores 1px of subpixel rounding so exact fits get no tooltip", () => {
    expect(isTitleTruncated(212, 211)).toBe(false);
  });
  it("reports fitting for an empty title", () => {
    expect(isTitleTruncated(0, 0)).toBe(false);
  });
  // On a phone the title wraps into a two-line -webkit-line-clamp, so the cut
  // moves to the Y axis and the box reports no horizontal overflow at all. A
  // 3-line title that is visually clipped must still get its tooltip.
  it("reports truncated when the box is clamped vertically (phone wrap)", () => {
    expect(isTitleTruncated(211, 211, 48, 31)).toBe(true);
  });
  it("reports fitting when the vertical measurement is absent", () => {
    expect(isTitleTruncated(211, 211)).toBe(false);
  });
});

describe("card title tooltip (0614a29e)", () => {
  it("reveals the full title when the box is only clamped vertically", () => {
    renderCard(makeTask());
    mockTruncation(211, 211, 48, 31);
    hoverTitle();
    expect(screen.getByText(LONG_TITLE, { selector: '[data-role="card-title-tip"]' })).toBeTruthy();
  });

  it("reveals the FULL title on hover when the title is truncated", () => {
    renderCard(makeTask());
    expect(
      screen.queryByRole("tooltip", { name: LONG_TITLE }),
    ).not.toBeInTheDocument();
    mockTruncation(668, 211);
    hoverTitle();
    const tip = screen.getByRole("tooltip", { name: LONG_TITLE });
    expect(tip).toBeInTheDocument();
    expect(tip).toHaveAttribute("data-role", "card-title-tip");
    expect(tip).toHaveClass("card-title-tip");
    // Full text, not the ellipsis-clipped row text.
    expect(tip.textContent).toBe(LONG_TITLE);
  });

  it("hides the tooltip when the pointer leaves the title", () => {
    renderCard(makeTask());
    mockTruncation(668, 211);
    const wrap = hoverTitle();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(wrap);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows NO tooltip on hover when the title fits (short title)", () => {
    renderCard(makeTask({ title: LONG_TITLE }));
    mockTruncation(211, 211);
    hoverTitle();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("renders the muted done-lane color variant without a tooltip when fitting", () => {
    render(
      <CardTitle title={LONG_TITLE} muted />,
    );
    const title = screen.getByText(LONG_TITLE, {
      selector: '[data-role="card-title"]',
    }) as HTMLElement;
    expect(title.style.color).toBe("var(--t-text-muted)");
    Object.defineProperty(title, "scrollWidth", {
      value: 100,
      configurable: true,
    });
    Object.defineProperty(title, "clientWidth", {
      value: 200,
      configurable: true,
    });
    fireEvent.mouseEnter(title);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
