import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimNextTaskAtomic,
  getParentId,
  isChildTask,
  isParentChainActive,
  getChildTasks,
  summariseChildren,
} from "../../src/core/tasks.js";
import type { Task } from "../../src/core/types.js";

/**
 * Root/child contract for the list and `--next` (task 94fcac0f, revised by
 * 4c846d52e2086cfe2f374fa9d6f312, then restricted by 4ab7104a).
 *
 * CURRENT RULE (4ab7104a): the root stays the unit of work — `--next` claims a
 * todo root first — and the child fallback only hands out a todo child of
 * LIVE work (every ancestor todo/in-progress/review). A todo child of a
 * backlog/done parent, or of a dangling link, is refused by the fallback and
 * reported loudly instead of sliced off. Filtered listings still include every
 * matching child with parent context, and `--get <id>` shows any root's
 * children — so refused children stay discoverable without being claimable.
 *
 * `claimNextTaskAtomic` with `rootsOnly: true` still skips parented tasks
 * (the CLI layer implements the fallback as a second call), so the MCP
 * surface and every test below keep their meaning.
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

describe("isParentChainActive", () => {
  const t = (id: string, status: string, parent?: string) =>
    ({
      id,
      status,
      links: parent ? [{ taskId: parent, type: "parent" }] : [],
    }) as unknown as Task;

  it("a root is always active", () => {
    const all = [t("r", "backlog")];
    expect(isParentChainActive(all, all[0])).toBe(true);
  });

  it("a child of a todo/in-progress/review parent is active", () => {
    for (const s of ["todo", "in-progress", "review"]) {
      const all = [t("p", s), t("c", "todo", "p")];
      expect(isParentChainActive(all, all[1])).toBe(true);
    }
  });

  it("a child of a backlog/done parent is inactive", () => {
    for (const s of ["backlog", "done"]) {
      const all = [t("p", s), t("c", "todo", "p")];
      expect(isParentChainActive(all, all[1])).toBe(false);
    }
  });

  it("a dangling parent link is inactive", () => {
    const all = [t("c", "todo", "gone")];
    expect(isParentChainActive(all, all[0])).toBe(false);
  });

  it("a cycle is inactive", () => {
    const all = [t("a", "todo", "b"), t("b", "todo", "a")];
    expect(isParentChainActive(all, all[0])).toBe(false);
  });

  it("walks the whole chain — an inactive grandparent vetoes", () => {
    const all = [t("gp", "backlog"), t("mid", "todo", "gp"), t("leaf", "todo", "mid")];
    expect(isParentChainActive(all, all[2])).toBe(false);
    const live = [t("gp", "review"), t("mid", "in-progress", "gp"), t("leaf", "todo", "mid")];
    expect(isParentChainActive(live, live[2])).toBe(true);
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

  it("returns null when every todo task is a child (core level — the CLI --next falls back to a child claim on null)", () => {
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

  it("rootsOnly:false refuses the todo child of a backlog parent — the fallback only serves live work", () => {
    writeTask(tmpDir, makeTask({ id: "parent", status: "backlog" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "kidLow",
        status: "todo",
        priority: "Low",
        links: [{ taskId: "parent", type: "parent" }],
      }),
    );
    writeTask(
      tmpDir,
      makeTask({
        id: "kidCritical",
        status: "todo",
        priority: "Critical",
        links: [{ taskId: "parent", type: "parent" }],
      }),
    );

    // Owner rule (ticket 4ab7104a): slicing a fragment off a parked unit is
    // worse than leaving it — the caller reports these loudly instead.
    expect(claimNextTaskAtomic(tmpDir, {})).toBeNull();
    expect(readStatus(tmpDir, "kidCritical")).toBe("todo");
  });

  it("rootsOnly:false still claims the child when the parent chain is live", () => {
    writeTask(tmpDir, makeTask({ id: "parent", status: "in-progress" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "kid",
        status: "todo",
        links: [{ taskId: "parent", type: "parent" }],
      }),
    );

    const claimed = claimNextTaskAtomic(tmpDir, {});
    expect(claimed?.id).toBe("kid");
    expect(claimed?.status).toBe("in-progress");
  });

  it("rootsOnly:false refuses children of done parents and dangling links", () => {
    writeTask(tmpDir, makeTask({ id: "doneParent", status: "done" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "doneKid",
        status: "todo",
        links: [{ taskId: "doneParent", type: "parent" }],
      }),
    );
    writeTask(
      tmpDir,
      makeTask({
        id: "orphanKid",
        status: "todo",
        links: [{ taskId: "gone", type: "parent" }],
      }),
    );

    expect(claimNextTaskAtomic(tmpDir, {})).toBeNull();
    expect(readStatus(tmpDir, "doneKid")).toBe("todo");
    expect(readStatus(tmpDir, "orphanKid")).toBe("todo");
  });

  it("rootsOnly:false refuses a todo child under a backlog grandparent", () => {
    writeTask(tmpDir, makeTask({ id: "grandparent", status: "backlog" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "mid",
        status: "todo",
        links: [{ taskId: "grandparent", type: "parent" }],
      }),
    );
    writeTask(
      tmpDir,
      makeTask({
        id: "leaf",
        status: "todo",
        links: [{ taskId: "mid", type: "parent" }],
      }),
    );

    expect(claimNextTaskAtomic(tmpDir, {})).toBeNull();
    expect(readStatus(tmpDir, "leaf")).toBe("todo");
  });

  it("allowInactiveParentChain:true restores the old fallback for explicit callers", () => {
    writeTask(tmpDir, makeTask({ id: "parent", status: "backlog" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "kid",
        status: "todo",
        links: [{ taskId: "parent", type: "parent" }],
      }),
    );

    const claimed = claimNextTaskAtomic(tmpDir, {
      allowInactiveParentChain: true,
    });
    expect(claimed?.id).toBe("kid");
  });
});
