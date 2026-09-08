/**
 * CLI display tests for task-details output.
 *
 * Tests that `formatRelationsSummary` (used by `printTaskDetails` in index.ts)
 * renders parent/children/related lines correctly to stdout.
 *
 * These are pure-function tests on formatRelationsSummary + taskRelations,
 * which is the formatting layer that drives the CLI `--get` display.
 */

import { describe, it, expect } from "vitest";
import {
  taskRelations,
  formatRelationsSummary,
} from "../../../src/core/task-links.js";
import type { Task } from "../../../src/core/types.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    description: overrides.description ?? "",
    status: overrides.status ?? "todo",
    selector: overrides.selector ?? "/",
    created: overrides.created ?? "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("CLI display — relations formatting", () => {
  it("prints parent line when task has a parent link", () => {
    const tasks = [
      makeTask({ id: "parent-1234567890", title: "Parent Task" }),
      makeTask({
        id: "child-1234567890ab",
        title: "My Child",
        links: [{ taskId: "parent-1234567890", type: "parent" }],
      }),
    ];
    const view = taskRelations(tasks, "child-1234567890ab");
    const lines = formatRelationsSummary(view);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("parent:");
    expect(lines[0]).toContain("parent-1"); // short id
    expect(lines[0]).toContain("Parent Task");
  });

  it("prints children (N) with short ids", () => {
    const tasks = [
      makeTask({ id: "parent-aaaa" }),
      makeTask({
        id: "child-bbbb",
        title: "First child",
        links: [{ taskId: "parent-aaaa", type: "parent" }],
      }),
      makeTask({
        id: "child-cccc",
        title: "Second child",
        status: "done",
        links: [{ taskId: "parent-aaaa", type: "parent" }],
      }),
      makeTask({
        id: "child-dddd",
        title: "Third child",
        status: "review",
        links: [{ taskId: "parent-aaaa", type: "parent" }],
      }),
      makeTask({
        id: "child-eeee",
        title: "Fourth child",
        status: "in-progress",
        links: [{ taskId: "parent-aaaa", type: "parent" }],
      }),
    ];
    const view = taskRelations(tasks, "parent-aaaa");
    const lines = formatRelationsSummary(view);

    const childrenLine = lines.find((l) => l.startsWith("children:"));
    expect(childrenLine).toBeDefined();
    // 4 children
    expect(childrenLine).toContain("children: 4");
    // Shows first 3 short ids
    expect(childrenLine).toContain("child-b");
    expect(childrenLine).toContain("child-c");
    expect(childrenLine).toContain("child-d");
    // Overflow
    expect(childrenLine).toContain("…and 1 more");
  });

  it("prints related lines", () => {
    const tasks = [
      makeTask({
        id: "task-relates-to-x",
        title: "My task",
        links: [{ taskId: "related-task-xxxx", type: "relates" }],
      }),
      makeTask({ id: "related-task-xxxx", title: "Related work" }),
    ];
    const view = taskRelations(tasks, "task-relates-to-x");
    const lines = formatRelationsSummary(view);

    const relatedLine = lines.find((l) => l.startsWith("related:"));
    expect(relatedLine).toBeDefined();
    expect(relatedLine).toContain("relates");
    expect(relatedLine).toContain("related-");
    expect(relatedLine).toContain("Related work");
  });

  it("prints blocked lines", () => {
    const tasks = [
      makeTask({
        id: "task-blocked-by-x",
        title: "Blocked task",
        links: [{ taskId: "blocker-task-xxxx", type: "blocks" }],
      }),
      makeTask({ id: "blocker-task-xxxx", title: "Blocker" }),
    ];
    const view = taskRelations(tasks, "task-blocked-by-x");
    const lines = formatRelationsSummary(view);

    const blockedLine = lines.find((l) => l.startsWith("blocked:"));
    expect(blockedLine).toBeDefined();
    expect(blockedLine).toContain("blocks");
    expect(blockedLine).toContain("Blocker");
  });

  it("no relation lines for task with no links", () => {
    const tasks = [makeTask({ id: "standalone-task" })];
    const view = taskRelations(tasks, "standalone-task");
    const lines = formatRelationsSummary(view);

    expect(lines).toEqual([]);
    expect(lines.find((l) => l.startsWith("parent:"))).toBeUndefined();
    expect(lines.find((l) => l.startsWith("children:"))).toBeUndefined();
    expect(lines.find((l) => l.startsWith("related:"))).toBeUndefined();
    expect(lines.find((l) => l.startsWith("blocked:"))).toBeUndefined();
  });

  it("dangling parent shows missing marker without crash", () => {
    const tasks = [
      makeTask({
        id: "orphan-task",
        links: [{ taskId: "missing-parent-id-xxxx", type: "parent" }],
      }),
    ];
    const view = taskRelations(tasks, "orphan-task");
    const lines = formatRelationsSummary(view);

    const parentLine = lines.find((l) => l.startsWith("parent:"));
    expect(parentLine).toBeDefined();
    expect(parentLine).toContain("missing-");
    expect(parentLine).toContain("(not found)");
  });
});
