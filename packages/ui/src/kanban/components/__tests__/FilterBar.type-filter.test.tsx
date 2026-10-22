// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { FilterBar, type FilterState } from "../FilterBar";
import type { Task } from "../../types";

afterEach(cleanup);

/**
 * Ticket zbew735s — the type filter offers exactly the canonical three
 * (Bug, Task, Research) from ONE exported constant, with a friendly label
 * per type; legacy stored values (Feature, Enhancement) never appear as
 * options, and picking a type fires the filter with the canonical value so
 * the call-site matcher can return the tasks stored under its legacy alias.
 */
const tasks: Task[] = [
  { id: "b1", title: "A bug", status: "todo", type: "Bug" },
  { id: "t1", title: "A task", status: "todo", type: "Task" },
  { id: "r1", title: "Some research", status: "todo", type: "Research" },
  { id: "f1", title: "Legacy feature", status: "todo", type: "Feature" as Task["type"] },
  { id: "e1", title: "Legacy enhancement", status: "todo", type: "Enhancement" as Task["type"] },
];

const baseFilter: FilterState = {
  status: "all",
  component: null,
  type: null,
  user: null,
  tags: [],
};

function openTypes() {
  fireEvent.click(screen.getByRole("button", { name: /type/i }));
}

describe("FilterBar type filter (zbew735s)", () => {
  it("shows exactly three type options despite legacy values on the board", () => {
    render(
      <FilterBar tasks={tasks} filter={baseFilter} onFilter={vi.fn()} />,
    );
    openTypes();
    expect(
      screen.getByRole("button", { name: "All types" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bug" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Task" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Research" }),
    ).toBeInTheDocument();
    // Legacy values never leak into the UI as filter options.
    expect(
      screen.queryByRole("button", { name: "Feature" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enhancement" }),
    ).not.toBeInTheDocument();
  });

  it("picking a type fires onFilter with the canonical value", () => {
    const onFilter = vi.fn();
    render(
      <FilterBar tasks={tasks} filter={baseFilter} onFilter={onFilter} />,
    );
    openTypes();
    fireEvent.click(screen.getByRole("button", { name: "Task" }));
    expect(onFilter).toHaveBeenCalledTimes(1);
    expect(onFilter).toHaveBeenCalledWith({ ...baseFilter, type: "Task" });
  });
});
