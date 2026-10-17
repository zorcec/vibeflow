/**
 * Listing limits + position metadata (ticket 9bb350a7).
 *
 * Job A — one shared default: the MCP `limit` schema default and the CLI
 * `--limit` default must BOTH resolve to DEFAULT_LIST_LIMIT from api-core.
 * The test below would have caught today's drift (5 vs 5, both unjustified
 * literals in different files).
 *
 * Job B — position metadata: offset / remaining / nextCursor / order ride on
 * every local listing, with the invariants
 *   truncated:     offset + returned + remaining === totalMatching
 *   not truncated: remaining === 0 AND nextCursor === null
 * pinned here. queryTaskList is pure, so these tests need no store.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { Command } from "commander";
import { DEFAULT_LIST_LIMIT, ListTasksInput } from "@vibeflow-tools/api-core";
import {
  queryTaskList,
  resolveListLimit,
  LIST_ORDER,
  encodeListCursor,
  decodeListCursor,
} from "../../src/core/task-listing.js";
import type { Task } from "../../src/core/types.js";

let seq = 0;
function makeTask(overrides: Partial<Task> & { id: string }): Task {
  seq += 1;
  return {
    title: `task ${overrides.id}`,
    description: "d",
    status: "todo",
    type: "Task",
    priority: "Medium",
    selector: "/",
    created: `2026-09-13T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    updated: "2026-09-13T10:00:00.000Z",
    ...overrides,
  } as Task;
}

function makeRoots(n: number): Task[] {
  return Array.from({ length: n }, (_, i) =>
    makeTask({ id: `root-${String(i).padStart(2, "0")}` }),
  );
}

// ── Job A: the drift guard ────────────────────────────────────────────────

describe("listing default limit: one shared constant (9bb350a7, job A)", () => {
  it("the shared default is the deliberate 20 (see the decision comment on DEFAULT_LIST_LIMIT)", () => {
    // Pinned WITH its rationale: the number must only change deliberately,
    // with the WHY-20 comment updated alongside it.
    expect(DEFAULT_LIST_LIMIT).toBe(20);
  });

  it("the MCP schema default resolves to the shared constant", () => {
    expect(ListTasksInput.parse({}).limit).toBe(DEFAULT_LIST_LIMIT);
  });

  it("the CLI --limit default resolves to the SAME constant", () => {
    expect(resolveListLimit(undefined)).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit(undefined)).toBe(ListTasksInput.parse({}).limit);
  });

  it("an explicit CLI value still parses exactly as before", () => {
    expect(resolveListLimit("5")).toBe(5);
    expect(resolveListLimit("0")).toBe(0);
  });

  it("the CLI --limit help text names the shared default", async () => {
    // The help string is built from the constant (template literal), so a
    // hand-edited number here would lie. Read it back through commander.
    process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
    process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
    try {
      const { createProgram } = await import("../../src/index.js");
      const program: Command = createProgram();
      const tasks = program.commands.find((c) => c.name() === "tasks");
      expect(tasks).toBeDefined();
      const limit = tasks!.options.find((o) => o.long === "--limit");
      expect(limit).toBeDefined();
      expect(limit!.description).toContain(
        `default: ${DEFAULT_LIST_LIMIT}`,
      );
    } finally {
      delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
      delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
    }
  });
});

// ── Job B: position metadata invariants ───────────────────────────────────

describe("listing position metadata (9bb350a7, job B)", () => {
  it("truncated: offset + returned + remaining === totalMatching, live cursor", () => {
    const all = makeRoots(25);
    const res = queryTaskList(all, { limit: 5 });

    expect(res.truncated).toBe(true);
    expect(res.offset).toBe(0);
    expect(res.returned).toBe(5);
    expect(res.totalMatching).toBe(25);
    expect(res.offset + res.returned + res.remaining).toBe(res.totalMatching);
    expect(res.remaining).toBe(20);
    expect(res.nextCursor).not.toBeNull();
    // The cursor encodes where this page stopped.
    expect(decodeListCursor(res.nextCursor!)).toBe(
      res.offset + res.returned,
    );
    expect(res.hint).toContain("limit 0");
    expect(res.order).toEqual([...LIST_ORDER]);
  });

  it("exhausted via limit:0: remaining === 0 and nextCursor === null", () => {
    const all = makeRoots(25);
    const res = queryTaskList(all, { limit: 0 });

    expect(res.tasks).toHaveLength(25);
    expect(res.returned).toBe(25);
    expect(res.truncated).toBe(false);
    expect(res.hint).toBeUndefined();
    expect(res.remaining).toBe(0);
    expect(res.nextCursor).toBeNull();
    expect(res.offset).toBe(0);
  });

  it("a limit above the set size exhausts too", () => {
    const all = makeRoots(3);
    const res = queryTaskList(all, { limit: 20 });

    expect(res.truncated).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.nextCursor).toBeNull();
  });

  it("a filtered listing reports its OWN totals, not the unfiltered ones", () => {
    const all = [
      makeTask({ id: "t1", status: "todo" }),
      makeTask({ id: "t2", status: "todo" }),
      makeTask({ id: "d1", status: "done" }),
      makeTask({ id: "d2", status: "done" }),
      makeTask({ id: "d3", status: "done" }),
    ];
    const res = queryTaskList(all, { status: "todo", limit: 1 });

    expect(res.totalMatching).toBe(2);
    expect(res.totalRoots).toBe(2);
    expect(res.returned).toBe(1);
    expect(res.offset + res.returned + res.remaining).toBe(res.totalMatching);
    expect(res.remaining).toBe(1);
    expect(res.nextCursor).not.toBeNull();
  });

  it("root-only corner is pinned: hidden rows count in remaining, cursor stays null", () => {
    // Unfiltered root-only with children present, limit NOT cutting: every
    // root is returned (truncated false) yet matching children are not in
    // this response. `remaining` counts them (they ARE matching rows not in
    // this response); the cursor stays null because it continues THIS
    // query's ordering — the same query would return the same rows. The
    // hidden rows are disclosed via hiddenChildren, revealed with
    // children:true.
    const all = [
      makeTask({ id: "root" }),
      makeTask({
        id: "kid-a",
        links: [{ taskId: "root", type: "parent" }],
      }),
      makeTask({
        id: "kid-b",
        links: [{ taskId: "root", type: "parent" }],
      }),
    ];
    const res = queryTaskList(all, {});

    expect(res.tasks.map((t) => t.id)).toEqual(["root"]);
    expect(res.truncated).toBe(false);
    expect(res.hiddenChildren).toBe(2);
    expect(res.remaining).toBe(2);
    expect(res.nextCursor).toBeNull();
  });

  it("order is the sort the code actually applies", () => {
    // status rank first (in-progress before todo), then priority
    // (Critical before Low), then updated newest-first, then id.
    const all = [
      makeTask({ id: "b-todo-low", status: "todo", priority: "Low" }),
      makeTask({ id: "a-inprogress", status: "in-progress" }),
      makeTask({
        id: "c-todo-critical",
        status: "todo",
        priority: "Critical",
      }),
    ];
    const res = queryTaskList(all, { limit: 0 });

    expect(res.tasks.map((t) => t.id)).toEqual([
      "a-inprogress",
      "c-todo-critical",
      "b-todo-low",
    ]);
    expect(res.order).toEqual([
      "status:asc",
      "priority:asc",
      "updated:desc",
      "id:asc",
    ]);
  });

  it("cursor round-trips; foreign tokens decode to null", () => {
    expect(decodeListCursor(encodeListCursor(5))).toBe(5);
    expect(decodeListCursor(encodeListCursor(0))).toBe(0);
    expect(decodeListCursor("not-a-cursor")).toBeNull();
    expect(decodeListCursor("")).toBeNull();
  });
});
