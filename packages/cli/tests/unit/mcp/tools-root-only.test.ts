/**
 * MCP parity with the CLI for the root/child contract (task 94fcac0f,
 * revised by 2471abb345fa, restricted by 4ab7104a).
 *
 * Both surfaces follow the SAME rule as the CLI's --next: roots first —
 * the root is the unit of work — with an explicit fallback to the
 * highest-priority matching todo child OF LIVE WORK (parent chain
 * todo/in-progress/review) when no todo root is claimable. Children of
 * backlog/done parents are refused, never sliced off.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listTasks, claimNextTask } from "../../../src/core/operations.js";
import type { Task } from "../../../src/core/types.js";
import type { OperationContext } from "../../../src/core/operations.js";

let testDir: string;
let ctx: OperationContext;

function write(overrides: Partial<Task> & { id: string }): Task {
  const task = {
    title: `t ${overrides.id}`,
    description: "d",
    status: "todo",
    selector: "/",
    created: "2026-09-13T10:00:00.000Z",
    comments: [],
    files: [],
    ...overrides,
  } as Task;
  const dir = join(testDir, ".vibeflow", "tasks", "2026-09-13");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task.id}.json`), JSON.stringify(task, null, 2));
  return task;
}

function readStatus(id: string): string {
  const raw = JSON.parse(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("node:fs").readFileSync(
      join(testDir, ".vibeflow", "tasks", "2026-09-13", `${id}.json`),
      "utf8",
    ),
  );
  return raw.status;
}

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-rootonly-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  ctx = { projectDir: testDir, mode: "local" };
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("mcp list_tasks root/child contract", () => {
  it("returns roots only by default and reports how many children were hidden", async () => {
    write({ id: "root" });
    write({ id: "kid-a", links: [{ taskId: "root", type: "parent" }] });
    write({ id: "kid-b", links: [{ taskId: "root", type: "parent" }] });

    const res = await listTasks(ctx, { limit: 0 } as never);

    expect(res.ok).toBe(true);
    const data = (
      res as { data: { tasks: Task[]; hiddenChildren: number } }
    ).data;
    expect(data.tasks.map((t) => t.id)).toEqual(["root"]);
    expect(data.hiddenChildren).toBe(2);
  });

  it("includes children when children:true and reports none hidden", async () => {
    write({ id: "root" });
    write({ id: "kid-a", links: [{ taskId: "root", type: "parent" }] });

    const res = await listTasks(ctx, { limit: 0, children: true } as never);

    const data = (
      res as { data: { tasks: Task[]; hiddenChildren: number } }
    ).data;
    expect(data.tasks.map((t) => t.id).sort()).toEqual(["kid-a", "root"]);
    expect(data.hiddenChildren).toBe(0);
  });

  it("a filtered query is an explicit search: matching children are included, like the CLI", async () => {
    // Parity contract 83159002: `vibeflow tasks --status todo` returns EVERY
    // matching task, children included — the MCP tool must answer the same.
    write({ id: "root", status: "todo" });
    write({
      id: "kid-todo",
      status: "todo",
      links: [{ taskId: "root", type: "parent" }],
    });
    write({
      id: "kid-done",
      status: "done",
      links: [{ taskId: "root", type: "parent" }],
    });

    const res = await listTasks(ctx, { limit: 0, status: "todo" } as never);

    const data = (
      res as {
        data: {
          tasks: Task[];
          totalMatching: number;
          totalRoots: number;
          hiddenChildren: number;
        };
      }
    ).data;
    // kid-done is filtered out by status; the matching child is returned.
    expect(data.tasks.map((t) => t.id).sort()).toEqual(["kid-todo", "root"]);
    expect(data.hiddenChildren).toBe(0);
    expect(data.totalMatching).toBe(2);
    expect(data.totalRoots).toBe(1);
  });
});

describe("mcp claim_next_task root/child contract", () => {
  it("prefers a root even when a child outranks it", async () => {
    write({ id: "root-medium", priority: "Medium" });
    write({
      id: "child-critical",
      priority: "Critical",
      links: [{ taskId: "root-medium", type: "parent" }],
    });

    const res = await claimNextTask(ctx, {} as never);

    expect(res.ok).toBe(true);
    expect((res as { data: Task }).data.id).toBe("root-medium");
    expect(readStatus("child-critical")).toBe("todo");
  });

  it("falls back to the child when every todo task is a child, and marks the child claim", async () => {
    // Same revised rule as the CLI's --next (ticket 4c846d52): a todo
    // child of a non-todo parent must never be invisible. Before
    // 2471abb345fa this answered "nothing to claim" while the CLI claimed
    // the child on the same board.
    write({ id: "parent", status: "in-progress" });
    write({
      id: "kid",
      links: [{ taskId: "parent", type: "parent" }],
    });

    const res = await claimNextTask(ctx, {} as never);

    expect(res.ok).toBe(true);
    expect((res as { data: Task }).data.id).toBe("kid");
    expect(readStatus("kid")).toBe("in-progress");
    // Unambiguous: the claim carries a CHILD_CLAIM notice naming the
    // parent, mirroring the CLI's CHILD CLAIM line.
    const steps = (res as { steps?: Array<{ code: string; message: string }> })
      .steps;
    const childClaim = steps?.find((s) => s.code === "CHILD_CLAIM");
    expect(childClaim).toBeDefined();
    expect(childClaim!.message).toContain("parent");
  });

  it("dry run prefers roots", async () => {
    write({ id: "root-medium", priority: "Medium" });
    write({
      id: "child-critical",
      priority: "Critical",
      links: [{ taskId: "root-medium", type: "parent" }],
    });
    const dryCtx: OperationContext = { ...ctx, dryRun: true };

    const res = await claimNextTask(dryCtx, {} as never);

    expect(res.ok).toBe(true);
    expect((res as { data: Task }).data.id).toBe("root-medium");
  });

  it("dry run falls back to a child when no todo root exists", async () => {
    write({ id: "parent", status: "in-progress" });
    write({
      id: "kid",
      links: [{ taskId: "parent", type: "parent" }],
    });
    const dryCtx: OperationContext = { ...ctx, dryRun: true };

    const res = await claimNextTask(dryCtx, {} as never);

    // The preview names the task the real call will claim — the child —
    // and marks it as a child claim. Nothing is written in dry run.
    expect(res.ok).toBe(true);
    expect((res as { data: Task }).data.id).toBe("kid");
    expect(readStatus("kid")).toBe("todo");
    const steps = (res as { steps?: Array<{ code: string }> }).steps ?? [];
    expect(steps.map((s) => s.code)).toEqual(["DRY_RUN", "CHILD_CLAIM"]);
  });
});
