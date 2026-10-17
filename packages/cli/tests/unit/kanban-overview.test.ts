/**
 * Unit tests for the overview aggregation (ticket 717d6335).
 *
 * Non-vacuity: every assertion below pins an exact number from a fixed
 * seed — flip any aggregate output and the test goes red (verified by
 * breaking the implementation during development: restore → green).
 */
import { describe, it, expect } from "vitest";
import { computeBoardOverview } from "../../src/client/kanban/overview.js";
import type { Task } from "@vibeflow-tools/ui/kanban";

const NOW = new Date("2026-10-17T12:00:00.000Z");

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    status: "todo",
    createdAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  } as Task;
}

describe("computeBoardOverview", () => {
  it("counts every status and totals a seeded board exactly", () => {
    const tasks = [
      task({ id: "a1", status: "backlog" }),
      task({ id: "a2", status: "todo" }),
      task({ id: "a3", status: "todo" }),
      task({ id: "a4", status: "in-progress" }),
      task({ id: "a5", status: "review" }),
      task({
        id: "a6",
        status: "done",
        updatedAt: "2026-10-17T08:00:00.000Z",
      }),
      task({
        id: "a7",
        status: "done",
        updatedAt: "2026-10-10T08:00:00.000Z",
      }),
    ];
    const o = computeBoardOverview(tasks, NOW);
    expect(o.total).toBe(7);
    expect(o.countsByStatus).toEqual({
      backlog: 1,
      todo: 2,
      "in-progress": 1,
      review: 1,
      done: 2,
    });
    // a6 finished today; a7 is older than 7 days → in neither window.
    expect(o.doneToday).toBe(1);
    expect(o.doneThisWeek).toBe(1);
  });

  it("counts done-this-week but not done-today for a 3-day-old finish", () => {
    const tasks = [
      task({
        id: "w1",
        status: "done",
        updatedAt: "2026-10-14T09:00:00.000Z",
      }),
    ];
    const o = computeBoardOverview(tasks, NOW);
    expect(o.doneToday).toBe(0);
    expect(o.doneThisWeek).toBe(1);
  });

  it("picks the oldest todo and in-progress by creation date", () => {
    const tasks = [
      task({
        id: "new-todo",
        title: "fresh todo",
        status: "todo",
        createdAt: "2026-10-16T00:00:00.000Z",
      }),
      task({
        id: "old-todo",
        title: "stale todo",
        status: "todo",
        createdAt: "2026-10-01T00:00:00.000Z",
      }),
      task({
        id: "old-wip",
        title: "stale wip",
        status: "in-progress",
        createdAt: "2026-10-05T12:00:00.000Z",
      }),
    ];
    const o = computeBoardOverview(tasks, NOW);
    expect(o.oldestTodo?.id).toBe("old-todo");
    expect(o.oldestTodo?.ageDays).toBe(16);
    expect(o.oldestInProgress?.id).toBe("old-wip");
    expect(o.oldestInProgress?.ageDays).toBe(12);
  });

  it("returns null staleness when a lane is empty", () => {
    const o = computeBoardOverview([task({ id: "d1", status: "done" })], NOW);
    expect(o.oldestTodo).toBeNull();
    expect(o.oldestInProgress).toBeNull();
  });

  it("breaks down assignees with open/done split, sorted by total", () => {
    const tasks = [
      task({ id: "b1", status: "todo", author: "bob" }),
      task({ id: "b2", status: "done", author: "bob" }),
      task({ id: "c1", status: "todo", author: "cara" }),
      task({ id: "u1", status: "todo" }),
    ];
    const o = computeBoardOverview(tasks, NOW);
    // Ties break by locale name order: "cara" < "Unassigned".
    expect(o.assignees).toEqual([
      { name: "bob", total: 2, open: 1, done: 1 },
      { name: "cara", total: 1, open: 1, done: 0 },
      { name: "Unassigned", total: 1, open: 1, done: 0 },
    ]);
  });

  it("handles an empty board without NaN or missing keys", () => {
    const o = computeBoardOverview([], NOW);
    expect(o.total).toBe(0);
    expect(o.countsByStatus).toEqual({
      backlog: 0,
      todo: 0,
      "in-progress": 0,
      review: 0,
      done: 0,
    });
    expect(o.doneToday).toBe(0);
    expect(o.doneThisWeek).toBe(0);
    expect(o.oldestTodo).toBeNull();
    expect(o.oldestInProgress).toBeNull();
    expect(o.assignees).toEqual([]);
  });
});
