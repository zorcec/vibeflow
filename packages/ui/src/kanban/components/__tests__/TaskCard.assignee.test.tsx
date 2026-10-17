// @vitest-environment jsdom
/**
 * Assignee badge: initials only, cleared when the item leaves the active
 * lane (ticket 297e71fb).
 *
 * Which badge this is: the BadgeCluster assignee pill in TaskCard.tsx — the
 * only card surface that renders a full person name as text. The presence
 * stack (DetailPanel) and the live-activity badge already render
 * `presenceInitials`, and neither is fed by the shipped client, so the
 * annotated full name ("Tomislav Zorčec") can only be this stored-field
 * pill. It reuses the same `presenceInitials` helper — no second
 * implementation.
 *
 * Clearing contract (bounded, no protocol change): the pill is derived
 * synchronously from the lane at render (`isInProgress ? assigneeName :
 * undefined`) — no cache, no timer. When the item leaves in-progress the
 * pill is gone on the next render, i.e. the staleness window is a single
 * render after the status update arrives (WS task-changed → merge, PATCH
 * response → merge, or the 5s poll fallback). Clearing on assignee
 * *inactivity* is NOT possible here without a protocol change (no
 * assignment timestamp, heartbeat, or disconnect reaches the card, and
 * task-merge preserves assigneeName across payloads that omit it), so no
 * unbounded expiry is shipped — and a stored assignment must survive a
 * disconnect anyway. See the lane report.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TaskCard } from "../TaskCard";
import type { Task, Column } from "../../types";

const inProgressCol: Column = {
  id: "in-progress",
  label: "In Progress",
  color: "#3b82f6",
  accent: "#3b82f6",
};

const doneCol: Column = {
  id: "done",
  label: "Done",
  color: "#22c55e",
  accent: "#22c55e",
};

const todoCol: Column = {
  id: "todo",
  label: "Todo",
  color: "#f59e0b",
  accent: "#f59e0b",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "assignee-task",
    title: "Assigned task",
    status: "in-progress",
    type: "Task",
    priority: undefined,
    tags: [],
    ...overrides,
  };
}

function renderCard(task: Task, col: Column) {
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

afterEach(() => {
  cleanup();
});

/**
 * Visible-row pill with the given hover title. The cluster renders every
 * badge twice (visible row + aria-hidden measurer), so a document-wide
 * title query would match the measurer twin — scope to the visible row.
 */
function visiblePill(name: string): HTMLElement | null {
  const cluster = document.querySelector(".card-badge-cluster");
  if (!cluster) return null;
  const pills = Array.from(
    cluster.querySelectorAll(":scope > span[title]"),
  ) as HTMLElement[];
  return pills.find((p) => p.getAttribute("title") === name) ?? null;
}

describe("Assignee badge initials (297e71fb)", () => {
  it("renders initials instead of the full name for a multi-word assignee", () => {
    renderCard(
      makeTask({ assigneeName: "Tomislav Zorčec" }),
      inProgressCol,
    );
    const pill = visiblePill("Tomislav Zorčec");
    expect(pill).not.toBeNull();
    expect(pill).toHaveTextContent("TZ");
    // No full name takes card space: the title attr is not rendered text.
    expect(screen.queryByText("Tomislav Zorčec")).toBeNull();
  });

  it("renders the first two letters for a single-word assignee", () => {
    renderCard(makeTask({ assigneeName: "Ana" }), inProgressCol);
    expect(visiblePill("Ana")).toHaveTextContent("AN");
  });

  it("trims extra whitespace before taking initials", () => {
    renderCard(
      makeTask({ assigneeName: "  ana   maria  " }),
      inProgressCol,
    );
    expect(visiblePill("  ana   maria  ")).toHaveTextContent("AM");
  });

  it("handles unicode names", () => {
    renderCard(
      makeTask({ assigneeName: "Zoë François" }),
      inProgressCol,
    );
    expect(visiblePill("Zoë François")).toHaveTextContent("ZF");
  });

  it("renders no pill for an empty or missing assignee", () => {
    const { container } = renderCard(
      makeTask({ assigneeName: "" }),
      inProgressCol,
    );
    expect(
      container.querySelector(".card-badge-cluster"),
    ).toBeInTheDocument();
    expect(visiblePill("")).toBeNull();
    cleanup();
    renderCard(makeTask({}), inProgressCol);
    expect(screen.queryByText("TZ")).toBeNull();
  });
});

describe("Assignee badge clearing (297e71fb)", () => {
  it("shows the pill while the item is in progress", () => {
    renderCard(
      makeTask({ assigneeName: "Tomislav Zorčec" }),
      inProgressCol,
    );
    expect(visiblePill("Tomislav Zorčec")).toBeInTheDocument();
  });

  it("clears the pill when the item leaves the active lane", () => {
    // NOTE: done-lane cards render title-only (no footer at all), so the
    // lane gate is exercised through the todo lane, which renders the
    // full footer — without the gate the pill would survive here.
    const task = makeTask({ assigneeName: "Tomislav Zorčec" });
    const { rerender } = render(
      <TaskCard
        task={task}
        col={inProgressCol}
        allTasks={[task]}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
    expect(visiblePill("Tomislav Zorčec")).toBeInTheDocument();
    // The item moved back to todo (no longer open/active): nothing on
    // the card may keep reporting the assignment status.
    rerender(
      <TaskCard
        task={{ ...task, status: "todo" }}
        col={todoCol}
        allTasks={[task]}
        onOpen={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );
    expect(visiblePill("Tomislav Zorčec")).toBeNull();
  });

  it("never renders the pill off the active lane, even with an assignee stored", () => {
    renderCard(
      makeTask({ status: "todo", assigneeName: "Tomislav Zorčec" }),
      todoCol,
    );
    expect(visiblePill("Tomislav Zorčec")).toBeNull();
  });

  it("renders no footer badges at all on a done (closed) item", () => {
    const { container } = renderCard(
      makeTask({ status: "done", assigneeName: "Tomislav Zorčec" }),
      doneCol,
    );
    // Done cards stay title-only: the whole badge cluster is gone, so no
    // status of any kind survives the item being closed.
    expect(
      container.querySelector(".card-badge-cluster"),
    ).toBeNull();
  });
});
