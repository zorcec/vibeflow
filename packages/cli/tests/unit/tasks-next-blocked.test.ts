import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimNextTaskAtomic,
  getUnfinishedBlockers,
  isBlockedByUnfinishedWork,
} from "../../src/core/tasks.js";
import type { Task } from "../../src/core/types.js";

/**
 * `--next` must not claim blocked work (ticket 0c0413f7, follow-up to 4c846d52).
 *
 * Only `done` satisfies a `blocks` link — `review` is NOT done (agents never
 * set `done`, so a gate sitting in review has not passed). The first test
 * below FAILS against the pre-fix code, which had no blocks awareness at all:
 * it claims the blocked child instead of skipping it.
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

/** A gate (blocker target) plus a todo blocked by it. */
function writeGateAndBlocked(
  tmpDir: string,
  gateStatus: string,
  blockedOverrides: Partial<Task> & { id: string },
) {
  writeTask(tmpDir, makeTask({ id: "gate", status: gateStatus }));
  writeTask(
    tmpDir,
    makeTask({
      ...blockedOverrides,
      links: [{ taskId: "gate", type: "blocks" }],
    }),
  );
}

describe("getUnfinishedBlockers / isBlockedByUnfinishedWork", () => {
  it("treats a review-status blocker as unfinished (review is NOT done)", () => {
    const gate = { id: "gate", status: "review" } as Task;
    const blocked = {
      id: "b",
      links: [{ taskId: "gate", type: "blocks" }],
    } as Task;
    expect(getUnfinishedBlockers(blocked, [gate, blocked]).map((t) => t.id)).toEqual([
      "gate",
    ]);
    expect(isBlockedByUnfinishedWork(blocked, [gate, blocked])).toBe(true);
  });

  it("treats a done blocker as satisfied", () => {
    const gate = { id: "gate", status: "done" } as Task;
    const blocked = {
      id: "b",
      links: [{ taskId: "gate", type: "blocks" }],
    } as Task;
    expect(getUnfinishedBlockers(blocked, [gate, blocked])).toEqual([]);
    expect(isBlockedByUnfinishedWork(blocked, [gate, blocked])).toBe(false);
  });

  it("ignores a dangling blocks target instead of wedging the queue", () => {
    const blocked = {
      id: "b",
      links: [{ taskId: "gone", type: "blocks" }],
    } as Task;
    expect(getUnfinishedBlockers(blocked, [blocked])).toEqual([]);
    expect(isBlockedByUnfinishedWork(blocked, [blocked])).toBe(false);
  });

  it("returns empty when there are no blocks links", () => {
    const plain = { id: "p", links: [] } as unknown as Task;
    expect(getUnfinishedBlockers(plain, [plain])).toEqual([]);
    expect(isBlockedByUnfinishedWork(plain, [plain])).toBe(false);
  });
});

describe("claimNextTaskAtomic skips blocked candidates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "next-blocked-"));
  });

  it("skips a todo child blocked by a review-status ticket (the P6 shape)", () => {
    writeTask(tmpDir, makeTask({ id: "epic", status: "in-progress" }));
    writeTask(tmpDir, makeTask({ id: "gate", status: "review" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "p6child",
        status: "todo",
        priority: "Critical",
        links: [
          { taskId: "epic", type: "parent" },
          { taskId: "gate", type: "blocks" },
        ],
      }),
    );

    // The blocked child is the ONLY todo: nothing may be claimed.
    const claimed = claimNextTaskAtomic(tmpDir, {});

    expect(claimed).toBeNull();
    expect(readStatus(tmpDir, "p6child")).toBe("todo");
  });

  it("claims the unblocked sibling instead of the blocked child", () => {
    writeTask(tmpDir, makeTask({ id: "epic", status: "in-progress" }));
    writeTask(tmpDir, makeTask({ id: "gate", status: "review" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "blockedKid",
        status: "todo",
        priority: "Critical",
        links: [
          { taskId: "epic", type: "parent" },
          { taskId: "gate", type: "blocks" },
        ],
      }),
    );
    writeTask(
      tmpDir,
      makeTask({
        id: "freeKid",
        status: "todo",
        priority: "High",
        links: [{ taskId: "epic", type: "parent" }],
      }),
    );

    const claimed = claimNextTaskAtomic(tmpDir, {});

    expect(claimed?.id).toBe("freeKid");
    expect(readStatus(tmpDir, "blockedKid")).toBe("todo");
  });

  it("skips a blocked root in favour of an unblocked root (root-first preserved)", () => {
    writeTask(tmpDir, makeTask({ id: "gate", status: "in-progress" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "blockedRoot",
        status: "todo",
        priority: "Critical",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
    );
    writeTask(
      tmpDir,
      makeTask({ id: "freeRoot", status: "todo", priority: "Medium" }),
    );

    const claimed = claimNextTaskAtomic(tmpDir, { rootsOnly: true });

    expect(claimed?.id).toBe("freeRoot");
    expect(readStatus(tmpDir, "blockedRoot")).toBe("todo");
  });

  it("a todo blocked by a done ticket IS claimable (no over-filtering)", () => {
    writeGateAndBlocked(tmpDir, "done", { id: "unblocked" });

    const claimed = claimNextTaskAtomic(tmpDir, {});

    expect(claimed?.id).toBe("unblocked");
    expect(claimed?.status).toBe("in-progress");
  });

  it("returns null when every candidate is blocked, and mutates nothing", () => {
    writeTask(tmpDir, makeTask({ id: "gate", status: "review" }));
    writeTask(
      tmpDir,
      makeTask({
        id: "blockedA",
        status: "todo",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
    );
    writeTask(
      tmpDir,
      makeTask({
        id: "blockedB",
        status: "todo",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
    );

    expect(claimNextTaskAtomic(tmpDir, { rootsOnly: true })).toBeNull();
    expect(claimNextTaskAtomic(tmpDir, {})).toBeNull();
    expect(readStatus(tmpDir, "blockedA")).toBe("todo");
    expect(readStatus(tmpDir, "blockedB")).toBe("todo");
  });
});
