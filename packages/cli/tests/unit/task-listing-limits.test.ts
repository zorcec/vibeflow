/**
 * Listing limits + position metadata (ticket 9bb350a7).
 *
 * Job A — one shared default: the MCP `limit` schema default and the CLI
 * `--limit` default must BOTH resolve to DEFAULT_LIST_LIMIT from api-core.
 * The test below would have caught today's drift (5 vs 5, both unjustified
 * literals in different files).
 *
 * Job B — position metadata: offset / remaining / nextCursor / order ride on
 * every local listing, with the invariants (scope rule revised b2e56212:
 * `remaining` counts down from the SCOPE size — totalRoots when root-only,
 * totalMatching otherwise — so hint and remaining always AGREE)
 *   truncated:     offset + returned + remaining === scopeRows
 *   not truncated: remaining === 0 AND nextCursor === null
 * pinned here. queryTaskList is pure, so these tests need no store.
 *
 * Job C (ticket b2e56212) — the listing contract stops hiding what it
 * knows: `limit: 0` resolves to the default LOUDLY (never unbounded),
 * `remaining` is scope-aware, and `queryAllTasks` is the explicit paged
 * helper for fetching everything.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { Command } from "commander";
import { DEFAULT_LIST_LIMIT, ListTasksInput } from "@vibeflow-tools/api-core";
import {
  queryTaskList,
  queryAllTasks,
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
  });

  it("limit 0 is NOT unlimited anymore: it resolves to the default (b2e56212 REVERSAL)", () => {
    // DELIBERATE REVERSAL (ticket b2e56212, owner decision): `0 = all` is
    // gone — 0, negatives and unparsable values fall back to the default,
    // and queryTaskList names the fallback in `limitNotice`. Never silent.
    expect(resolveListLimit("0")).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit("-5")).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListLimit("abc")).toBe(DEFAULT_LIST_LIMIT);
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
  it("truncated: offset + returned + remaining === scope size, live cursor", () => {
    const all = makeRoots(25);
    const res = queryTaskList(all, { limit: 5 });

    expect(res.truncated).toBe(true);
    expect(res.offset).toBe(0);
    expect(res.returned).toBe(5);
    expect(res.totalMatching).toBe(25);
    expect(res.totalRoots).toBe(25);
    expect(res.offset + res.returned + res.remaining).toBe(res.totalRoots);
    expect(res.remaining).toBe(20);
    expect(res.nextCursor).not.toBeNull();
    // The cursor encodes where this page stopped.
    expect(decodeListCursor(res.nextCursor!)).toBe(
      res.offset + res.returned,
    );
    // Ticket b2e56212: the hint no longer teaches `0 = all`.
    expect(res.hint).toContain("showing 5 of 25 matching");
    expect(res.hint).toContain("nextCursor");
    expect(res.hint).not.toContain("limit 0");
    // Hint and remaining AGREE on the scope (that agreement is the bug).
    expect(res.hint).toContain(`of ${res.totalRoots} matching`);
    expect(res.limitNotice).toBeUndefined();
    expect(res.order).toEqual([...LIST_ORDER]);
  });

  it("limit:0 resolves to the default LOUDLY and is NOT unbounded (b2e56212)", () => {
    // DELIBERATE REVERSAL: `0 = all` is gone. On a 25-root board an
    // explicit limit:0 behaves EXACTLY like omitting the parameter — 20
    // rows, truncation metadata, a live cursor — AND says so.
    const all = makeRoots(25);
    const res = queryTaskList(all, { limit: 0 });

    expect(res.tasks).toHaveLength(DEFAULT_LIST_LIMIT);
    expect(res.returned).toBe(DEFAULT_LIST_LIMIT);
    expect(res.limit).toBe(DEFAULT_LIST_LIMIT);
    expect(res.truncated).toBe(true);
    expect(res.nextCursor).not.toBeNull();
    expect(res.remaining).toBe(25 - DEFAULT_LIST_LIMIT);
    // LOUDLY: the notice names what happened — assert the TEXT, not just
    // the row count, or a silent reinterpretation passes this test.
    expect(res.limitNotice).toBe(
      `limit 0 is not supported — applied the default of ${DEFAULT_LIST_LIMIT}; page with nextCursor`,
    );
  });

  it("limit:0 on a below-default board returns every row but still says so", () => {
    const all = makeRoots(3);
    const res = queryTaskList(all, { limit: 0 });

    expect(res.tasks).toHaveLength(3);
    expect(res.truncated).toBe(false);
    expect(res.hint).toBeUndefined();
    expect(res.remaining).toBe(0);
    expect(res.nextCursor).toBeNull();
    // The resolved limit is echoed even when nothing was cut: the caller
    // asked for 0 and got the default page, which happened to hold all 3.
    expect(res.limit).toBe(DEFAULT_LIST_LIMIT);
    expect(res.limitNotice).toContain("limit 0 is not supported");
  });

  it("an omitted limit resolves to the default WITHOUT a notice", () => {
    // Omitting the parameter is the normal path — no apology needed.
    const all = makeRoots(25);
    const res = queryTaskList(all, {});

    expect(res.limit).toBe(DEFAULT_LIST_LIMIT);
    expect(res.limitNotice).toBeUndefined();
    expect(res.returned).toBe(DEFAULT_LIST_LIMIT);
    expect(res.truncated).toBe(true);
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

  it("root-only corner is pinned: remaining counts the ROOT scope, cursor stays null (b2e56212 REVERSAL)", () => {
    // DELIBERATE REVERSAL of the 9bb350a7 corner (ticket b2e56212): the old
    // test pinned remaining === 2 here (hidden children counted). That made
    // `remaining` overstate the fetchable work by exactly hiddenChildren
    // while `hint` truthfully reported the root scope. Now `remaining`
    // counts down from totalRoots: every in-scope row IS in this response,
    // so remaining is 0. totalMatching/totalRoots/hiddenChildren are
    // untouched — they stay unscoped-truthful. The cursor stays null
    // because it continues THIS query's ordering — the same query would
    // return the same rows; the hidden rows are disclosed via
    // hiddenChildren, revealed with children:true.
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
    expect(res.totalMatching).toBe(3);
    expect(res.totalRoots).toBe(1);
    expect(res.hiddenChildren).toBe(2);
    expect(res.remaining).toBe(0);
    expect(res.offset + res.returned + res.remaining).toBe(res.totalRoots);
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
    const res = queryTaskList(all, {});

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

// ── Job C: scope-aware remaining + explicit paging (b2e56212) ───────────────

describe("scope-aware remaining and explicit paging (b2e56212, job C)", () => {
  function makeBoard() {
    // 5 roots + 2 children on different parents: the DEFAULT call shape
    // (no children flag, no filter) can only ever return the 5 roots.
    const roots = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `c-root-${i}` }),
    );
    const kids = [0, 1].map((i) =>
      makeTask({
        id: `c-kid-${i}`,
        links: [{ taskId: `c-root-${i}`, type: "parent" }],
      }),
    );
    return [...roots, ...kids];
  }

  it("DEFAULT call shape (no children, no filter): hint and remaining AGREE on the root scope", () => {
    // THE actual bug: with children:true all fields agreed, but the default
    // call computed remaining against totalMatching (children included)
    // while hint reported the root scope — disagreeing by hiddenChildren.
    const res = queryTaskList(makeBoard(), { limit: 2 });

    expect(res.totalMatching).toBe(7);
    expect(res.totalRoots).toBe(5);
    expect(res.hiddenChildren).toBe(2);
    expect(res.returned).toBe(2);
    expect(res.truncated).toBe(true);
    // Agreement, not just arithmetic: hint names the root scope size AND
    // remaining counts down from it. The old code said "2 of 5" with
    // remaining 5 — parse both numbers out and require them to match.
    expect(res.hint).toContain("showing 2 of 5 matching");
    expect(res.remaining).toBe(3);
    expect(res.offset + res.returned + res.remaining).toBe(res.totalRoots);
    const hintScope = Number(/of (\d+) matching/.exec(res.hint!)![1]);
    expect(hintScope).toBe(res.totalRoots);
    expect(res.offset + res.returned + res.remaining).toBe(hintScope);
    expect(res.nextCursor).not.toBeNull();
  });

  it("children:true: hint and remaining AGREE on the full scope", () => {
    const res = queryTaskList(makeBoard(), { limit: 2, children: true });

    expect(res.totalMatching).toBe(7);
    expect(res.hiddenChildren).toBe(0);
    expect(res.returned).toBe(2);
    expect(res.truncated).toBe(true);
    expect(res.hint).toContain("showing 2 of 7 matching");
    expect(res.remaining).toBe(5);
    expect(res.offset + res.returned + res.remaining).toBe(res.totalMatching);
    const hintScope = Number(/of (\d+) matching/.exec(res.hint!)![1]);
    expect(hintScope).toBe(res.totalMatching);
    expect(res.offset + res.returned + res.remaining).toBe(hintScope);
    expect(res.nextCursor).not.toBeNull();
  });

  it("a filtered search counts down from totalMatching (children always included)", () => {
    const all = [
      makeTask({ id: "f-todo-root", status: "todo" }),
      makeTask({
        id: "f-todo-kid",
        status: "todo",
        links: [{ taskId: "f-todo-root", type: "parent" }],
      }),
      makeTask({ id: "f-done-root", status: "done" }),
    ];
    const res = queryTaskList(all, { status: "todo", limit: 1 });

    expect(res.totalMatching).toBe(2);
    expect(res.hiddenChildren).toBe(0);
    expect(res.returned).toBe(1);
    expect(res.remaining).toBe(1);
    expect(res.offset + res.returned + res.remaining).toBe(res.totalMatching);
    expect(res.hint).toContain("showing 1 of 2 matching");
  });

  it("--all pages across cursors and returns the complete set with no single unbounded request", () => {
    // 45 roots: three bounded pages of 20/20/5. The server never
    // materialises the full set in one read — the helper advances offset
    // through the same cursor contract a remote caller pages with.
    const all = makeRoots(45);
    const res = queryAllTasks(all, {});

    expect(res.tasks).toHaveLength(45);
    expect(res.returned).toBe(45);
    expect(res.totalMatching).toBe(45);
    expect(res.truncated).toBe(false);
    expect(res.remaining).toBe(0);
    expect(res.nextCursor).toBeNull();
    // Bounded per request: the echoed limit is the page size used, and the
    // rows arrive in the same order a cursor walk would produce.
    expect(res.limit).toBe(DEFAULT_LIST_LIMIT);
    const walked = queryTaskList(all, { limit: DEFAULT_LIST_LIMIT });
    expect(res.tasks.map((t) => t.id)).toEqual([
      ...walked.tasks.map((t) => t.id),
      ...queryTaskList(all, {
        limit: DEFAULT_LIST_LIMIT,
        offset: DEFAULT_LIST_LIMIT,
      }).tasks.map((t) => t.id),
      ...queryTaskList(all, {
        limit: DEFAULT_LIST_LIMIT,
        offset: 2 * DEFAULT_LIST_LIMIT,
      }).tasks.map((t) => t.id),
    ]);
  });

  it("offset pages continue exactly where the cursor stopped", () => {
    const all = makeRoots(25);
    const first = queryTaskList(all, { limit: 5 });
    expect(first.nextCursor).not.toBeNull();
    const at = decodeListCursor(first.nextCursor!)!;
    const second = queryTaskList(all, { limit: 5, offset: at });

    expect(second.offset).toBe(5);
    expect(second.returned).toBe(5);
    expect(second.remaining).toBe(15);
    expect(second.offset + second.returned + second.remaining).toBe(25);
    // No overlap, no gap: the two pages tile the first ten sorted rows.
    const sortedIds = queryAllTasks(all, { pageSize: 25 }).tasks.map(
      (t) => t.id,
    );
    expect([...first.tasks, ...second.tasks].map((t) => t.id)).toEqual(
      sortedIds.slice(0, 10),
    );
  });
});
