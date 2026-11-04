/**
 * Fuzzy search listing contract (ticket mq8azbxthl824162fnr4at49).
 *
 * `queryTaskList`/`queryAllTasks` with `search` use the shared matcher
 * (`@vibeflow-tools/shared`) — title + description + comments + tags — and
 * rank by relevance (score, then id), NOT the listing order, so every
 * surface (CLI local/remote, MCP, web) returns the same ids in the same
 * order. A non-blank search is a filtered query: children included, with
 * the same limit/truncated/remaining/nextCursor contract. Blank search =
 * no search (legacy listing byte-identical).
 */
import { describe, it, expect } from "vitest";
import { ListTasksInput } from "@vibeflow-tools/api-core";
import { SEARCH_ORDER, SEARCH_QUERY_MAX_LENGTH } from "@vibeflow-tools/shared";
import {
  queryTaskList,
  queryAllTasks,
  LIST_ORDER,
} from "../../src/core/task-listing.js";
import type { Task } from "../../src/core/types.js";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `task ${overrides.id}`,
    description: "plain description",
    status: "todo",
    type: "Task",
    priority: "Medium",
    selector: "/",
    created: "2026-09-13T10:00:00.000Z",
    updated: "2026-09-13T10:00:00.000Z",
    ...overrides,
  } as Task;
}

const BOARD: Task[] = [
  makeTask({ id: "a1", title: "Fix the flaky widget export", status: "todo" }),
  makeTask({
    id: "b2",
    title: "Unrelated docs refresh",
    description: "mentions widget export deep in the text",
    status: "todo",
  }),
  makeTask({
    id: "c3",
    title: "Weekly gardening rota",
    comments: [
      {
        id: "cm1",
        author: "user",
        text: "remember the widget export deadline",
        createdAt: "2026-09-13T10:00:00.000Z",
      },
    ],
    status: "done",
  }),
  makeTask({
    id: "d4",
    title: "Tag the release",
    tags: ["widget-export"],
    status: "backlog",
  }),
  makeTask({ id: "e5", title: "Totally unrelated", status: "todo" }),
];

describe("search is declared on the MCP input schema", () => {
  it("ListTasksInput accepts and keeps a search string", () => {
    expect(ListTasksInput.parse({ search: "widget export" }).search).toBe(
      "widget export",
    );
  });

  it("ListTasksInput rejects an over-long search", () => {
    expect(() =>
      ListTasksInput.parse({ search: "x".repeat(201) }),
    ).toThrow();
  });

  it("the MCP max length cannot drift from the shared matcher constant", () => {
    // api-core duplicates SEARCH_QUERY_MAX_LENGTH (see its comment) —
    // this pins the two spellings to the same number behaviourally.
    expect(() =>
      ListTasksInput.parse({ search: "x".repeat(SEARCH_QUERY_MAX_LENGTH) }),
    ).not.toThrow();
    expect(() =>
      ListTasksInput.parse({ search: "x".repeat(SEARCH_QUERY_MAX_LENGTH + 1) }),
    ).toThrow();
  });
});

describe("queryTaskList with search", () => {
  it("matches across title, description, comments and tags — not just title", () => {
    const result = queryTaskList(BOARD, { search: "widget export" });
    expect(result.tasks.map((t) => t.id).sort()).toEqual(
      ["a1", "b2", "c3", "d4"].sort(),
    );
    expect(result.totalMatching).toBe(4);
  });

  it("is fuzzy, not substring: a dropped char still matches", () => {
    // "wdget" is NOT a substring of "widget", but IS a subsequence of
    // it — the old substring implementation would return zero rows here.
    // (The decoy shares no w/d/g/e/t subsequence, so it stays out.)
    const board = [
      makeTask({ id: "only", title: "Fix the widget export" }),
      makeTask({ id: "other", title: "Polish the onboarding tour" }),
    ];
    const result = queryTaskList(board, { search: "wdget" });
    expect(result.tasks.map((t) => t.id)).toEqual(["only"]);
  });

  it("ranks by relevance (score, then id), not the listing order", () => {
    const result = queryTaskList(BOARD, { search: "widget export" });
    // The simple rule, no field weights: earlier + tighter wins wherever
    // it matches — the tag hit at position 0 (d4) outranks the mid-title
    // hit (a1), which outranks nothing here. Deterministic everywhere.
    expect(result.tasks.map((t) => t.id)).toEqual(["d4", "b2", "c3", "a1"]);
    expect(result.order).toEqual([...SEARCH_ORDER]);
  });

  it("includes children and done tasks — a search is a filtered query", () => {
    const board: Task[] = [
      makeTask({ id: "parent", title: "Parent task" }),
      {
        ...makeTask({ id: "child", title: "Parent follow-up work" }),
        links: [{ taskId: "parent", type: "parent" as const }],
      } as Task,
    ];
    const result = queryTaskList(board, { search: "parent" });
    expect(result.tasks.map((t) => t.id).sort()).toEqual(["child", "parent"]);
    expect(result.hiddenChildren).toBe(0);
  });

  it("composes with exact filters (status narrows, matcher ranks)", () => {
    const result = queryTaskList(BOARD, {
      search: "widget export",
      status: "todo",
    });
    expect(result.tasks.map((t) => t.id).sort()).toEqual(["a1", "b2"]);
  });

  it("keeps the limit/truncated/remaining/nextCursor contract", () => {
    const result = queryTaskList(BOARD, { search: "widget export", limit: 2 });
    expect(result.returned).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.nextCursor).not.toBeNull();
    // offset + returned + remaining === scope size (totalMatching: search
    // always includes children).
    expect(result.offset + result.returned + result.remaining).toBe(
      result.totalMatching,
    );
    expect(result.hint).toBeTruthy();
  });

  it("blank search behaves like no search (listing order, LIST_ORDER echo)", () => {
    const result = queryTaskList(BOARD, { search: "   " });
    expect(result.totalMatching).toBe(BOARD.length);
    expect(result.order).toEqual([...LIST_ORDER]);
  });

  it("no match returns an exhausted page, not an error", () => {
    const result = queryTaskList(BOARD, { search: "zzzqqq-nope" });
    expect(result.tasks).toEqual([]);
    expect(result.totalMatching).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.nextCursor).toBeNull();
  });
});

describe("queryAllTasks with search", () => {
  it("assembles the whole matching set, relevance-ranked, exhausted envelope", () => {
    const result = queryAllTasks(BOARD, { search: "widget export" });
    expect(result.tasks.map((t) => t.id)).toEqual(
      queryTaskList(BOARD, {
        search: "widget export",
        limit: 100,
      }).tasks.map((t) => t.id),
    );
    expect(result.truncated).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(result.order).toEqual([...SEARCH_ORDER]);
  });
});
