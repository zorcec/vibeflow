import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimNextTaskAtomic,
  getParentId,
  isChildTask,
  getChildTasks,
  summariseChildren,
} from "../../src/core/tasks.js";
import type { Task } from "../../src/core/types.js";

/**
 * Root/child contract for the list and `--next` (task 94fcac0f).
 *
 * OWNER DECISION: an agent is given the ROOT unit of work, never a fragment of
 * it. `--next` considers only roots, and returns the root's children alongside
 * it so the agent can see what remains.
 */

const PROTO = ".vibeflow";
const TASKS_DIR = "tasks";

function taskJson(projectDir: string, id: string) {
  return join(projectDir, PROTO, TASKS_DIR, id + ".json");
}

function writeTask(projectDir: string, task: Record<string, unknown>) {
  const dir = join(projectDir, PROTO, TASKS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    taskJson(projectDir, task.id as string),
    JSON.stringify(task, null, 2) + "\n",
  );
}

function readStatus(projectDir: string, id: string): string {
  const raw = JSON.parse(readFileSync(taskJson(projectDir, id), "utf8"));
  return raw.status;
}

let seq = 0;
function makeTask(
  overrides: Partial<Task> & { id: string },
): Record<string, unknown> {
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
  };
}

describe("isChildTask / getParentId", () => {
  it("treats a task with a parent link as a child", () => {
    const child = { id: "c", links: [{ taskId: "p", type: "parent" }] } as Task;
    expect(getParentId(child)).toBe("p");
    expect(isChildTask(child)).toBe(true);
  });

  it("treats a task without a parent link as a root", () => {
    const root = { id: "r", links: [] } as unknown as Task;
    expect(getParentId(root)).toBeUndefined();
    expect(isChildTask(root)).toBe(false);
  });

  it("treats a missing links array as a root", () => {
    expect(isChildTask({ id: "r" } as Task)).toBe(false);
  });

  it("counts a dangling parent link as a child, so the task is never silently lost", () => {
    // The board nests a parented task under its root. If a dangling link made it
    // a "root" here, it would render in the parent's tree AND list as a peer.
    const orphan = {
      id: "o",
      links: [{ taskId: "gone", type: "parent" }],
    } as Task;
    expect(isChildTask(orphan)).toBe(true);
  });

  it("ignores non-parent links", () => {
    const relates = {
      id: "x",
      links: [{ taskId: "y", type: "relates" }],
    } as Task;
    expect(isChildTask(relates)).toBe(false);
  });
});

describe("getChildTasks / summariseChildren", () => {
  const all = [
    { id: "p", links: [] },
    { id: "c1", links: [{ taskId: "p", type: "parent" }] },
    { id: "c2", links: [{ taskId: "p", type: "parent" }] },
    { id: "other", links: [] },
  ] as unknown as Task[];

  it("returns only the direct children of the given parent", () => {
    expect(getChildTasks(all, "p").map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(getChildTasks(all, "other")).toEqual([]);
  });

  it("summarises children to id, title and status only", () => {
    const withMeta = [
      {
        id: "p",
        links: [],
      },
      {
        id: "c1",
        title: "child one",
        status: "todo",
        priority: "High",
        description: "a very long description that must not be inlined",
        links: [{ taskId: "p", type: "parent" }],
      },
    ] as unknown as Task[];
    const summaries = summariseChildren(withMeta, "p");
    expect(summaries).toEqual([
      { id: "c1", title: "child one", status: "todo", priority: "High" },
    ]);
    expect(Object.keys(summaries[0])).not.toContain("description");
  });

  it("omits priority when the child has none", () => {
    const bare = [
      { id: "p", links: [] },
      {
        id: "c",
        title: "c",
        status: "done",
        links: [{ taskId: "p", type: "parent" }],
      },
    ] as unknown as Task[];
    expect(summariseChildren(bare, "p")).toEqual([
      { id: "c", title: "c", status: "done" },
    ]);
  });
});

describe("claimNextTaskAtomic with rootsOnly", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "roots-only-"));
  });

  it("never claims a child — even when the child outranks every root", () => {
    writeTask(
      tmpDir,
      makeTask({ id: "rootMedium", status: "todo", priority: "Medium" }),
    );
    writeTask(
      tmpDir,
      makeTask({
        id: "childCritical",
        status: "todo",
        priority: "Critical",
        links: [{ taskId: "rootMedium", type: "parent" }],
      }),
    );

    const claimed = claimNextTaskAtomic(tmpDir, { rootsOnly: true });

    // The Critical child must be skipped entirely, not just deprioritised.
    expect(claimed?.id).toBe("rootMedium");
    expect(readStatus(tmpDir, "childCritical")).toBe("todo");
  });

  it("claims the child when rootsOnly is not set — the opt-in is what changes behaviour", () => {
    writeTask(
      tmpDir,
      makeTask({ id: "rootMedium", status: "todo", priority: "Medium" }),
    );
    writeTask(
      tmpDir,
      makeTask({
        id: "childCritical",
        status: "todo",
        priority: "Critical",
        links: [{ taskId: "rootMedium", type: "parent" }],
      }),
    );

    const claimed = claimNextTaskAtomic(tmpDir, {});

    expect(claimed?.id).toBe("childCritical");
  });

  it("claims a root that carries children, and leaves the children untouched", () => {
    writeTask(tmpDir, makeTask({ id: "root", status: "todo" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "kid",
        status: "todo",
        links: [{ taskId: "root", type: "parent" }],
      }),
    );

    const claimed = claimNextTaskAtomic(tmpDir, { rootsOnly: true });

    expect(claimed?.id).toBe("root");
    expect(claimed?.status).toBe("in-progress");
    // Claiming the root does NOT cascade — the agent walks the children itself.
    expect(readStatus(tmpDir, "kid")).toBe("todo");
  });

  it("returns null when every todo task is a child", () => {
    writeTask(tmpDir, makeTask({ id: "parent", status: "in-progress" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "kid",
        status: "todo",
        links: [{ taskId: "parent", type: "parent" }],
      }),
    );

    expect(claimNextTaskAtomic(tmpDir, { rootsOnly: true })).toBeNull();
  });
});
