/**
 * Shared claim-eligibility fixtures (ticket 6452504d, parent e7482da5).
 *
 * The acceptance fixtures for the atomic claim contract: late-priority
 * ordering (a high-priority root arriving after dozens of older low-priority
 * roots is still claimed first — no pre-filter window can hide it),
 * unfinished-blocker suppression (a blocked task is never claimed, even at
 * the top of the order), ancestry (parked/dangling/cyclic parents are never
 * claimable; live chains fall back to children), empty boards, and the
 * roots-first / child-fallback shape.
 *
 * Each fixture runs against BOTH the live primitive (`claimNextTaskAtomic`,
 * which writes) and the read-only selector (`selectClaimCandidate`), and
 * the two must agree — the selector IS the primitive's policy.
 *
 * Mutation notes (each was broken on purpose while writing):
 * - late priority: capping the pool (e.g. `.slice(0, 25)`) before policy
 *   claims an old low-priority root instead of the late high one → red;
 * - blockers: removing the unfinished-blocker check claims the gated task → red;
 * - ancestry: inspecting only the direct parent, or counting `review` as
 *   done, claims stranded/gated children → red.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selectClaimCandidate,
  collectBlockedCandidates,
  collectStrandedCandidates,
} from "../../src/core/claim-eligibility.js";
import { claimNextTaskAtomic, listTasks } from "../../src/core/tasks.js";
import type { Task } from "../../src/core/types.js";

const PROTO = ".vibeflow";
const TASKS_DIR = "tasks";

function writeTask(projectDir: string, task: Record<string, unknown>) {
  const dir = join(projectDir, PROTO, TASKS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
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

function seed(dir: string, tasks: Array<Record<string, unknown>>) {
  for (const t of tasks) writeTask(dir, t);
}

function readStatus(dir: string, id: string): string {
  return (
    JSON.parse(
      readFileSync(join(dir, PROTO, TASKS_DIR, `${id}.json`), "utf8"),
    ) as { status: string }
  ).status;
}

describe("selectClaimCandidate fixtures", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eligibility-"));
    seq = 0;
  });

  it("late high-priority root wins over dozens of older low-priority roots", () => {
    const tasks: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 30; i++) {
      tasks.push(
        makeTask({
          id: `old-${i}`,
          priority: "Low",
          created: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }
    tasks.push(
      makeTask({
        id: "late-high",
        priority: "High",
        created: "2026-09-13T10:00:00.000Z",
      }),
    );
    seed(tmpDir, tasks);

    // Read-only selector …
    const pick = selectClaimCandidate(listTasks(tmpDir));
    expect(pick?.task.id).toBe("late-high");
    expect(pick?.childClaim).toBe(false);
    // … and the live primitive agree.
    const claimed = claimNextTaskAtomic(tmpDir);
    expect(claimed?.id).toBe("late-high");
    expect(readStatus(tmpDir, "late-high")).toBe("in-progress");
  });

  it("a blocked top candidate is skipped for the next eligible root", () => {
    seed(tmpDir, [
      makeTask({ id: "gate", status: "review" }),
      makeTask({
        id: "gated-top",
        priority: "Critical",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
      makeTask({ id: "free-second", priority: "High" }),
    ]);
    const pick = selectClaimCandidate(listTasks(tmpDir));
    expect(pick?.task.id).toBe("free-second");
    const claimed = claimNextTaskAtomic(tmpDir);
    expect(claimed?.id).toBe("free-second");
    expect(readStatus(tmpDir, "gated-top")).toBe("todo");
  });

  it("all candidates blocked means nothing is claimable", () => {
    seed(tmpDir, [
      makeTask({ id: "gate", status: "in-progress" }),
      makeTask({
        id: "gated-a",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
      makeTask({
        id: "gated-b",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
    ]);
    expect(selectClaimCandidate(listTasks(tmpDir))).toBeNull();
    expect(claimNextTaskAtomic(tmpDir)).toBeNull();
    expect(readStatus(tmpDir, "gated-a")).toBe("todo");
  });

  it("a blocker that is done satisfies the link (no over-filtering)", () => {
    seed(tmpDir, [
      makeTask({ id: "gate", status: "done" }),
      makeTask({
        id: "unblocked",
        priority: "Critical",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
    ]);
    expect(selectClaimCandidate(listTasks(tmpDir))?.task.id).toBe(
      "unblocked",
    );
    expect(claimNextTaskAtomic(tmpDir)?.id).toBe("unblocked");
  });

  it("a dangling blocker target does not wedge the queue", () => {
    seed(tmpDir, [
      makeTask({
        id: "dangling-block",
        links: [{ taskId: "missing-gate", type: "blocks" }],
      }),
    ]);
    expect(selectClaimCandidate(listTasks(tmpDir))?.task.id).toBe(
      "dangling-block",
    );
  });

  it("children of parked parents are never claimed (backlog/done)", () => {
    for (const parentStatus of ["backlog", "done"]) {
      const dir = mkdtempSync(join(tmpdir(), "eligibility-parked-"));
      seed(dir, [
        makeTask({ id: "parked-parent", status: parentStatus }),
        makeTask({
          id: "parked-child",
          links: [{ taskId: "parked-parent", type: "parent" }],
        }),
      ]);
        expect(selectClaimCandidate(listTasks(dir))).toBeNull();
      expect(claimNextTaskAtomic(dir)).toBeNull();
      expect(readStatus(dir, "parked-child")).toBe("todo");
      // … but they are REPORTED as stranded, never invisible.
      const stranded = collectStrandedCandidates(listTasks(dir));
      expect(stranded.map((s) => s.id)).toEqual(["parked-child"]);
      expect(stranded[0].parentStatus).toBe(parentStatus);
    }
  });

  it("dangling and cyclic ancestry is never claimable", () => {
    seed(tmpDir, [
      makeTask({
        id: "dangling-child",
        links: [{ taskId: "ghost-parent", type: "parent" }],
      }),
      makeTask({
        id: "cycle-a",
        links: [{ taskId: "cycle-b", type: "parent" }],
      }),
      makeTask({
        id: "cycle-b",
        links: [{ taskId: "cycle-a", type: "parent" }],
      }),
    ]);
    expect(selectClaimCandidate(listTasks(tmpDir))).toBeNull();
    expect(claimNextTaskAtomic(tmpDir)).toBeNull();
  });

  it("a single call mixes roots and children by priority (primitive parity)", () => {
    // Pinned primitive semantics (ticket tasks-root-only): WITHOUT rootsOnly
    // one call orders every eligible candidate together — a Critical child
    // beats a Medium root. Strict roots-first is the operation's two-phase
    // use of this selector (rootsOnly first, fallback on null).
    seed(tmpDir, [
      makeTask({ id: "rootMedium", priority: "Medium" }),
      makeTask({
        id: "childCritical",
        priority: "Critical",
        links: [{ taskId: "rootMedium", type: "parent" }],
      }),
    ]);
    const mixed = selectClaimCandidate(listTasks(tmpDir));
    expect(mixed?.task.id).toBe("childCritical");
    expect(mixed?.childClaim).toBe(true);
    expect(claimNextTaskAtomic(tmpDir)?.id).toBe("childCritical");
  });

  it("rootsOnly stays strict even when a child outranks every root", () => {
    seed(tmpDir, [
      makeTask({ id: "rootMedium", priority: "Medium" }),
      makeTask({
        id: "childCritical",
        priority: "Critical",
        links: [{ taskId: "rootMedium", type: "parent" }],
      }),
    ]);
    const strict = selectClaimCandidate(listTasks(tmpDir), {
      rootsOnly: true,
    });
    expect(strict?.task.id).toBe("rootMedium");
    expect(strict?.childClaim).toBe(false);
    expect(claimNextTaskAtomic(tmpDir, { rootsOnly: true })?.id).toBe(
      "rootMedium",
    );
  });

  it("child of a live chain is the fallback when no eligible root exists", () => {
    seed(tmpDir, [
      makeTask({ id: "epic", status: "in-progress" }),
      makeTask({
        id: "live-child",
        priority: "High",
        links: [{ taskId: "epic", type: "parent" }],
      }),
    ]);
    const pick = selectClaimCandidate(listTasks(tmpDir));
    expect(pick?.task.id).toBe("live-child");
    expect(pick?.childClaim).toBe(true);
    expect(pick?.parentId).toBe("epic");
    const claimed = claimNextTaskAtomic(tmpDir);
    expect(claimed?.id).toBe("live-child");
    expect(readStatus(tmpDir, "live-child")).toBe("in-progress");
  });

  it("a blocked child falls back past itself while a free child is taken", () => {
    seed(tmpDir, [
      makeTask({ id: "gate", status: "review" }),
      makeTask({ id: "epic", status: "in-progress" }),
      makeTask({
        id: "gated-child",
        priority: "Critical",
        links: [
          { taskId: "epic", type: "parent" },
          { taskId: "gate", type: "blocks" },
        ],
      }),
      makeTask({
        id: "free-child",
        priority: "High",
        links: [{ taskId: "epic", type: "parent" }],
      }),
    ]);
    expect(selectClaimCandidate(listTasks(tmpDir))?.task.id).toBe(
      "free-child",
    );
    expect(claimNextTaskAtomic(tmpDir)?.id).toBe("free-child");
    expect(readStatus(tmpDir, "gated-child")).toBe("todo");
  });

  it("an empty board selects nothing", () => {
    expect(selectClaimCandidate(listTasks(tmpDir))).toBeNull();
    expect(claimNextTaskAtomic(tmpDir)).toBeNull();
  });

  it("filters match exactly (no case-folding without explicit approval)", () => {
    seed(tmpDir, [
      makeTask({ id: "typed", type: "Task", author: "Zoe" }),
      makeTask({ id: "other", type: "Bug", author: "zoe" }),
    ]);
    const board = listTasks(tmpDir);
    // Exact case only: lowercase spellings match nothing.
    expect(selectClaimCandidate(board, { type: "task" })).toBeNull();
    expect(selectClaimCandidate(board, { user: "zoe" })?.task.id).toBe(
      "other",
    );
    expect(selectClaimCandidate(board, { type: "Task" })?.task.id).toBe(
      "typed",
    );
    expect(
      selectClaimCandidate(board, { tag: ["nope"] }),
    ).toBeNull();
  });

  it("blocked candidates are collected for display after the claim", () => {
    seed(tmpDir, [
      makeTask({ id: "gate", status: "review" }),
      makeTask({
        id: "gated",
        links: [{ taskId: "gate", type: "blocks" }],
      }),
      makeTask({ id: "free", priority: "Low" }),
    ]);
    // Claim first (takes "free"), then the remainder is exactly the refusal.
    expect(claimNextTaskAtomic(tmpDir)?.id).toBe("free");
    const blocked = collectBlockedCandidates(listTasks(tmpDir));
    expect(blocked.map((b) => b.task.id)).toEqual(["gated"]);
    expect(blocked[0].blockers.map((b) => b.id)).toEqual(["gate"]);
  });
});

describe("claimNextTask operation roots-first (two-phase)", () => {
  it("claims the eligible root over a higher-priority live child, with no CHILD_CLAIM", async () => {
    // The operation (unlike a single primitive call) is strict roots-first:
    // it claims rootsOnly first and only falls back on null — so a Medium
    // root wins over its own Critical child, and the result carries no
    // child-claim notice.
    const dir = mkdtempSync(join(tmpdir(), "eligibility-op-"));
    for (const t of [
      makeTask({ id: "rootMedium", priority: "Medium" }),
      makeTask({
        id: "childCritical",
        priority: "Critical",
        links: [{ taskId: "rootMedium", type: "parent" }],
      }),
    ]) {
      writeTask(dir, t);
    }
    const { claimNextTask } = await import("../../src/core/operations.js");
    const result = await claimNextTask({ projectDir: dir, mode: "local" }, {});
    expect(result.ok).toBe(true);
    expect(result.data?.id).toBe("rootMedium");
    expect(result.steps).toBeUndefined();
  });
});

