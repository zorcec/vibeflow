import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StatusDot, TaskCard } from "../TaskCard";
import { STATUS_COLORS, STATUS_LABELS } from "../../task-links";
import type { Task, Column, TaskStatus } from "../../types";

/**
 * Ticket kwaz437j — "Add ticket status (colour is enough, tooltip on hover)".
 *
 * The board card shows the ticket's status as a colour dot with the status
 * name on hover. The colour comes from the canonical STATUS_COLORS mapping
 * (design tokens, no hex literals); the name is present twice — `title`
 * for the mouse HOVER tooltip and `role="img"` + `aria-label` so colour
 * is never the only carrier. R11 honest fix: `title` does not open on
 * keyboard focus in any browser, so the dot is deliberately NOT focusable
 * (a tab stop with no behaviour is keyboard noise) and no keyboard-tooltip
 * claim is made — keyboard and screen-reader users get the name from the
 * accessible tree instead. No badge chip, no redesign.
 *
 * Multi-row cards (the board's open lanes) draw StatusDot; single-row
 * cards (compact view) reuse the leading slot's status dot, upgraded with
 * the same name/tooltip/AT contract. The done lane keeps its green done
 * glyph by the existing mark precedence, so done is covered at the
 * StatusDot component level.
 */

/** Lanes whose board card is the multi-row layout. */
const MULTI_ROW: TaskStatus[] = ["backlog", "todo", "in-progress", "review"];

function col(id: TaskStatus): Column {
  return { id, label: STATUS_LABELS[id], color: "#888", accent: "#888" };
}

function makeTask(status: TaskStatus): Task {
  return {
    id: `task-${status}`,
    title: `Card in ${status}`,
    status,
    type: "Task",
  };
}

function renderCard(task: Task, extra: object = {}) {
  return render(
    <TaskCard
      task={task}
      col={col(task.status)}
      allTasks={[task]}
      onOpen={vi.fn()}
      onDragStart={vi.fn()}
      {...extra}
    />,
  );
}

/** The status dot, wherever the card layout draws it. */
function statusDot(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    '[data-role="status-dot"]',
  );
  if (!el) throw new Error("no status dot rendered");
  return el;
}

describe("TaskCard status dot (kwaz437j)", () => {
  it.each(MULTI_ROW)(
    "%s multi-row card renders its mapped colour token",
    (status) => {
      const { container } = renderCard(makeTask(status));
      const dot = statusDot(container);
      expect(dot).toHaveAttribute("data-status", status);
      expect(dot.style.background).toBe(STATUS_COLORS[status]);
      expect(dot.style.background).toMatch(/var\(--/);
    },
  );

  it.each([...MULTI_ROW, "done"] as TaskStatus[])(
    "%s StatusDot renders its mapped colour token",
    (status) => {
      const { container } = render(<StatusDot status={status} />);
      const dot = statusDot(container);
      expect(dot).toHaveAttribute("data-status", status);
      expect(dot.style.background).toBe(STATUS_COLORS[status]);
    },
  );

  it.each([...MULTI_ROW, "done"] as TaskStatus[])(
    "%s StatusDot names the status for hover and assistive tech, and is not a tab stop",
    (status) => {
      const { container } = render(<StatusDot status={status} />);
      const label = STATUS_LABELS[status];
      // Accessible name carries the status name (colour is never the only
      // carrier) …
      expect(
        screen.getByRole("img", { name: `Status: ${label}` }),
      ).toBe(statusDot(container));
      // … and the mouse hover tooltip carries it too …
      expect(statusDot(container)).toHaveAttribute("title", label);
      // … but the tooltip is hover-only: `title` never opens on keyboard
      // focus, so the dot takes no tab stop (R11 — the old tabindex="0"
      // promised a keyboard tooltip no browser shows).
      expect(statusDot(container)).not.toHaveAttribute("tabindex");
    },
  );

  it("row layout (compact) carries the same colour, name and tooltip", () => {
    const { container } = renderCard(makeTask("review"), { compact: true });
    const dot = statusDot(container);
    expect(dot).toHaveAttribute("data-status", "review");
    expect(dot.style.background).toBe(STATUS_COLORS.review);
    expect(dot.style.background).toMatch(/var\(--/);
    expect(dot).toHaveAttribute("title", STATUS_LABELS.review);
    expect(dot).not.toHaveAttribute("tabindex");
    expect(
      screen.getByRole("img", { name: `Status: ${STATUS_LABELS.review}` }),
    ).toBe(dot);
  });

  it("adds no badge chip and leaves the card intact", () => {
    const { container } = renderCard(makeTask("todo"));
    expect(
      container.querySelector('[data-role="task-card"]'),
    ).toBeInTheDocument();
    expect(statusDot(container).textContent).toBe("");
  });
});
