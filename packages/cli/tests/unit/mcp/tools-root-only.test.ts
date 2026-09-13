/**
 * MCP parity with the CLI for the root/child contract (task 94fcac0f).
 *
 * The CLI lists and claims ROOT tasks only; the MCP tools must behave the same
 * way, or an MCP client would keep claiming children the board conceals.
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
    const data = (res as { data: { tasks: Task[]; hiddenChildren: number } }).data;
    expect(data.tasks.map((t) => t.id)).toEqual(["root"]);
    expect(data.hiddenChildren).toBe(2);
  });

  it("includes children when children:true and reports none hidden", async () => {
    write({ id: "root" });
    write({ id: "kid-a", links: [{ taskId: "root", type: "parent" }] });

    const res = await listTasks(ctx, { limit: 0, children: true } as never);

    const data = (res as { data: { tasks: Task[]; hiddenChildren: number } }).data;
    expect(data.tasks.map((t) => t.id).sort()).toEqual(["kid-a", "root"]);
    expect(data.hiddenChildren).toBe(0);
  });

  it("counts only children that matched the other filters", async () => {
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

    const data = (res as { data: { tasks: Task[]; hiddenChildren: number } }).data;
    expect(data.tasks.map((t) => t.id)).toEqual(["root"]);
    // kid-done is filtered out by status before the child count is taken.
    expect(data.hiddenChildren).toBe(1);
  });
});

describe("mcp claim_next_task root/child contract", () => {
  it("never claims a child, even when the child outranks every root", async () => {
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

  it("reports no task when every todo task is a child", async () => {
    write({ id: "parent", status: "in-progress" });
    write({
      id: "kid",
      links: [{ taskId: "parent", type: "parent" }],
    });

    const res = await claimNextTask(ctx, {} as never);

    expect(res.ok).toBe(false);
  });

  it("dry run also skips children", async () => {
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
});
