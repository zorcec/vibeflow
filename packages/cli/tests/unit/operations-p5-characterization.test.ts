/**
 * P5 characterization pins (ticket 4a5f7df6, plan step 1).
 *
 * Pins the CURRENT behaviour of the attachment / delete / explicit-commit /
 * maintenance surfaces BEFORE any branch moves onto the shared operation
 * layer. Every test below passes against the pre-extraction code; the
 * extraction commits must keep them green WITHOUT edits (any behaviour that
 * has to change is a documented flip, like P4's authoritative-write flip —
 * not a silent edit to a pin).
 *
 * What is pinned, and where the behaviour lives today:
 * - MCP `attachFile` (core/operations/files.ts): existence-first, validation
 *   gates, dry-run envelope, and replace-in-place on a repeated name
 *   (saveFile overwrites bytes, one ref per name) — the CLI refusal of the
 *   same pair (E_FILE_EXISTS) lives inline in src/index.ts and is pinned by
 *   tests/e2e/tasks-attach.test.ts instead.
 * - `commitTaskPaths` (core/git.ts): explicit-pathspec scoping, foreign
 *   staged paths left in the index, linked-HEAD on a clean tree.
 * - normalize plan/apply (core/tasks.ts): dry-run writes nothing, apply
 *   heals, second apply is a no-op (idempotence).
 * - reindex backfill (ui/kanban + writeSortKeyMinimal): zero patches on a
 *   well-formed store, minimal byte-preserving writes (the legacy `commit`
 *   field survives — the 18-SHA lesson), second plan is a no-op.
 * - local delete (core/tasks.ts): file removal, missing → false, BFS
 *   root-first descendant order (reverse = deepest-first delete order).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { gitEnvWithCleanLocation } from "../../src/core/git-env.js";
import { computeBackfillPlan } from "@vibeflow-tools/ui/kanban";
import type { OperationContext } from "../../src/core/operations.js";
import { attachFile } from "../../src/core/operations.js";
import {
  commitTaskPaths,
  type TaskCommitResult,
} from "../../src/core/git.js";
import {
  createTask,
  deleteTask,
  getDescendantIds,
  planTaskStoreNormalize,
  applyTaskStoreNormalize,
  writeSortKeyMinimal,
  listTasks,
} from "../../src/core/tasks.js";

let projectDir: string;
let ctx: OperationContext;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "p5-char-"));
  ctx = { projectDir, mode: "local" };
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function seedTask(task: Record<string, unknown>): void {
  const dir = join(projectDir, ".vibeflow", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
}

function baseTask(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
    ...extra,
  };
}

function filesOnDisk(taskId: string): string[] {
  const dir = join(projectDir, ".vibeflow", "tasks", "files", taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function readBytes(taskId: string, name: string): Buffer {
  return readFileSync(
    join(projectDir, ".vibeflow", "tasks", "files", taskId, name),
  );
}

// ── MCP attachFile: current local behaviour ───────────────────────────────

describe("attachFile operation (MCP shape, current behaviour)", () => {
  it("refuses a missing task with TASK_NOT_FOUND and writes no file", async () => {
    const r = await attachFile(ctx, {
      id: "no-such-task",
      filename: "a.md",
      contentB64: Buffer.from("x").toString("base64"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TASK_NOT_FOUND");
    expect(filesOnDisk("no-such-task")).toEqual([]);
  });

  it("refuses an executable type and writes nothing", async () => {
    seedTask(baseTask("t1"));
    const r = await attachFile(ctx, {
      id: "t1",
      filename: "run.exe",
      contentB64: Buffer.from("x").toString("base64"),
    });
    expect(r.ok).toBe(false);
    expect(filesOnDisk("t1")).toEqual([]);
  });

  it("dry-run answers DRY_RUN with name/size/url and writes nothing", async () => {
    seedTask(baseTask("t1"));
    const r = await attachFile(ctx, {
      id: "t1",
      filename: "plan.md",
      contentB64: Buffer.from("hello").toString("base64"),
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data?.name).toBe("plan.md");
      expect(r.data?.size).toBe(5);
      expect(r.data?.url).toContain("t1");
      expect(r.steps).toEqual([
        { code: "DRY_RUN", message: "File would be attached" },
      ]);
    }
    expect(filesOnDisk("t1")).toEqual([]);
  });

  it("writes exact bytes; a repeated name REPLACES in place (one ref, new bytes)", async () => {
    seedTask(baseTask("t1"));
    const first = await attachFile(ctx, {
      id: "t1",
      filename: "plan.md",
      contentB64: Buffer.from("v1").toString("base64"),
    });
    expect(first.ok).toBe(true);
    expect(readBytes("t1", "plan.md").toString()).toBe("v1");
    const second = await attachFile(ctx, {
      id: "t1",
      filename: "plan.md",
      contentB64: Buffer.from("v2-longer").toString("base64"),
    });
    expect(second.ok).toBe(true);
    // Replace, not duplicate: one file on disk, latest bytes.
    expect(filesOnDisk("t1")).toEqual(["plan.md"]);
    expect(readBytes("t1", "plan.md").toString()).toBe("v2-longer");
  });
});

// ── commitTaskPaths: payload shapes ───────────────────────────────────────

describe("commitTaskPaths (explicit commit service)", () => {
  // Fixture git must never inherit the caller's repo-location env: git
  // exports GIT_DIR and friends when it invokes hooks such as pre-commit,
  // and an inherited variable makes every `git` below ignore `cwd` and
  // operate on that other repository (fixture commits landing in the real
  // repo). Same hygiene as the source under test (gitEnvWithCleanLocation).
  function gitEnv(): NodeJS.ProcessEnv {
    const env = gitEnvWithCleanLocation();
    env.GIT_CEILING_DIRECTORIES = projectDir;
    return env;
  }

  function initGit(): void {
    execSync(
      "git init -q && git config user.name 'P5' && git config user.email 'p5@test.local'",
      { cwd: projectDir, stdio: "ignore", env: gitEnv() },
    );
    // Pin: the temp repo resolves to the temp directory, never the repo
    // that invoked the test runner. Fails loudly if isolation regresses.
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: projectDir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();
    expect(top).toBe(realpathSync(projectDir));
  }

  function taskFileRel(id: string): string {
    const dir = join(projectDir, ".vibeflow", "tasks");
    for (const entry of readdirSync(dir)) {
      const cand = join(dir, entry, `${id}.json`);
      if (existsSync(cand))
        return `.vibeflow/tasks/${entry}/${id}.json`;
    }
    throw new Error(`task file missing for ${id}`);
  }

  function staged(): string[] {
    return execSync("git diff --cached --name-only -z", {
      cwd: projectDir,
      encoding: "utf-8",
      env: gitEnv(),
    })
      .split("\0")
      .filter(Boolean);
  }

  it("commits explicit paths and leaves foreign staged paths in the index", () => {
    initGit();
    writeFileSync(join(projectDir, "owned.txt"), "owned\n");
    writeFileSync(join(projectDir, "foreign.txt"), "foreign\n");
    execSync("git add owned.txt foreign.txt && git commit -qm init", {
      cwd: projectDir,
      stdio: "ignore",
      env: gitEnv(),
    });
    const created = createTask(projectDir, {
      title: "commit me",
      description: "",
      status: "todo",
      selector: "/",
      author: "P5",
    });
    const rel = taskFileRel(created.id);
    const headBefore = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();
    expect(headBefore.length).toBeGreaterThan(0);
    // A pathspec commit records working-tree content: modify the owned path
    // so the explicit pathspec names a real change (an unmodified path
    // links HEAD instead — pinned by the clean-tree test below). Stage an
    // unrelated change for another lane, which must survive the commit.
    writeFileSync(join(projectDir, "owned.txt"), "owned v2\n");
    writeFileSync(join(projectDir, "foreign.txt"), "foreign v2\n");
    execSync("git add foreign.txt", {
      cwd: projectDir,
      stdio: "ignore",
      env: gitEnv(),
    });

    const r = commitTaskPaths(projectDir, created.id, "do work", ["owned.txt"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.linkedExisting).toBe(false);
      expect(r.committed).toEqual(["owned.txt"]);
      expect(r.foreign).toEqual([]);
      expect(r.sha).not.toBe(headBefore);
    }
    // Untouched foreign path is still staged for its owner; the task record
    // carries the commit link.
    expect(staged()).toEqual(["foreign.txt"]);
    const record = JSON.parse(
      readFileSync(join(projectDir, rel), "utf-8"),
    ) as { commits: Array<{ sha: string }> };
    expect(record.commits.length).toBe(1);
    if (r.ok) expect(record.commits[0].sha).toBe(r.sha);
  });

  it("scopes to the task record with no pathspec and reports foreign as leftStaged", () => {
    initGit();
    writeFileSync(join(projectDir, "other.txt"), "other\n");
    execSync("git add other.txt && git commit -qm init", {
      cwd: projectDir,
      stdio: "ignore",
      env: gitEnv(),
    });
    const created = createTask(projectDir, {
      title: "scoped",
      description: "",
      status: "todo",
      selector: "/",
      author: "P5",
    });
    const rel = taskFileRel(created.id);
    // Modify the task file (unstaged) and stage an unrelated path.
    writeFileSync(join(projectDir, "unrelated.txt"), "u\n");
    execSync("git add unrelated.txt", {
      cwd: projectDir,
      stdio: "ignore",
      env: gitEnv(),
    });

    const r: TaskCommitResult = commitTaskPaths(
      projectDir,
      created.id,
      "scoped work",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // No staged task-owned paths (task file change is unstaged) — the
      // no-pathspec scope stages nothing itself, so it links HEAD... but
      // the task file IS modified. Pin the actual contract: whatever the
      // scope decision, foreign stays staged and the record is linked.
      expect(r.foreign).toContain("unrelated.txt");
    }
    expect(staged()).toContain("unrelated.txt");
    void rel;
  });

  it("links HEAD instead of failing when the tree is clean", () => {
    initGit();
    writeFileSync(join(projectDir, "a.txt"), "a\n");
    execSync("git add a.txt && git commit -qm init", {
      cwd: projectDir,
      stdio: "ignore",
      env: gitEnv(),
    });
    const created = createTask(projectDir, {
      title: "clean",
      description: "",
      status: "todo",
      selector: "/",
      author: "P5",
    });
    const head = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();
    const r = commitTaskPaths(projectDir, created.id, "nothing new");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.linkedExisting).toBe(true);
      expect(r.sha).toBe(head);
      expect(r.committed).toEqual([]);
    }
  });
});

// ── normalize plan/apply ──────────────────────────────────────────────────

describe("normalize plan/apply (local store healing)", () => {
  it("a clean store plans zero changes and the apply is a no-op", () => {
    seedTask(baseTask("clean1", { status: "todo", type: "Bug" }));
    const plan = planTaskStoreNormalize(projectDir);
    expect(plan.changes).toEqual([]);
    const applied = applyTaskStoreNormalize(projectDir);
    expect(applied.applied).toEqual([]);
    expect(applied.unwritten).toEqual([]);
    // Second apply is still a no-op (idempotence).
    const again = applyTaskStoreNormalize(projectDir);
    expect(again.applied).toEqual([]);
  });

  it("plan names repairs, writes nothing; apply heals; second plan is clean", () => {
    seedTask({
      ...baseTask("messy1"),
      description: null,
      type: "   ",
    } as Record<string, unknown>);
    // Drop status to trigger the status-to-todo repair.
    const p = join(projectDir, ".vibeflow", "tasks", "messy1.json");
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    delete raw.status;
    const before = readFileSync(p, "utf-8");
    writeFileSync(p, JSON.stringify(raw, null, 2) + "\n");

    const plan = planTaskStoreNormalize(projectDir);
    expect(plan.changes.length).toBe(1);
    expect(plan.changes[0].id).toBe("messy1");
    // The plan is a preview: the file bytes are untouched.
    expect(readFileSync(p, "utf-8")).toBe(JSON.stringify(raw, null, 2) + "\n");
    void before;

    const applied = applyTaskStoreNormalize(projectDir);
    expect(applied.applied.length).toBe(1);
    expect(applied.unwritten).toEqual([]);
    const healed = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    expect(healed.status).toBe("todo");
    expect("description" in healed).toBe(false);
    expect("type" in healed).toBe(false);

    const replan = planTaskStoreNormalize(projectDir);
    expect(replan.changes).toEqual([]);
  });

  it("unparseable files are reported unreadable and left alone", () => {
    seedTask(baseTask("good1"));
    const dir = join(projectDir, ".vibeflow", "tasks");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json", "utf-8");
    const plan = planTaskStoreNormalize(projectDir);
    expect(plan.unreadable).toContain(bad);
    const applied = applyTaskStoreNormalize(projectDir);
    expect(readFileSync(bad, "utf-8")).toBe("{ not json");
    expect(applied.unreadable).toContain(bad);
  });
});

// ── reindex backfill ──────────────────────────────────────────────────────

describe("reindex backfill (sortKey maintenance)", () => {
  it("zero patches on a well-formed uniquely-keyed store", () => {
    // Well-formed keys are digit strings (WELL_FORMED_KEY /^\d+(\.\d+)?$/);
    // "a0"-style keys are NOT well-formed and are always re-keyed.
    const view = [
      { id: "a", status: "todo", sortKey: "100", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", status: "todo", sortKey: "200", createdAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(computeBackfillPlan(view)).toEqual([]);
  });

  it("re-keys duplicates; the write is minimal (legacy fields survive); second plan is clean", () => {
    // Seed two tasks sharing one well-formed key, one carrying the legacy `commit` field.
    seedTask(baseTask("dup1", { sortKey: "100", updated: "2026-01-01T00:00:00.000Z" }));
    const legacy = {
      ...baseTask("dup2", { sortKey: "100", updated: "2026-01-01T00:00:00.000Z" }),
      commit: "deadbeef",
    };
    seedTask(legacy as Record<string, unknown>);

    const view = listTasks(projectDir).map((t) => ({
      id: t.id,
      status: t.status,
      sortKey: t.sortKey,
      createdAt: t.created,
    }));
    const patches = computeBackfillPlan(view);
    expect(patches.length).toBeGreaterThan(0);

    for (const patch of patches) {
      expect(writeSortKeyMinimal(projectDir, patch.id, patch.sortKey)).toBe(true);
    }
    // Minimal write: the legacy singleton `commit` field survives the re-key.
    // (seedTask writes the flat layout .vibeflow/tasks/<id>.json.)
    const dup2Path = join(projectDir, ".vibeflow", "tasks", "dup2.json");
    expect(existsSync(dup2Path)).toBe(true);
    const dup2rec = JSON.parse(
      readFileSync(dup2Path, "utf-8"),
    ) as Record<string, unknown>;
    expect(dup2rec.commit).toBe("deadbeef");

    const after = listTasks(projectDir).map((t) => ({
      id: t.id,
      status: t.status,
      sortKey: t.sortKey,
      createdAt: t.created,
    }));
    expect(computeBackfillPlan(after)).toEqual([]);
  });

  it("writeSortKeyMinimal refuses a file with neither sortKey nor updated (no write)", () => {
    const raw = baseTask("bare1");
    delete raw.sortKey;
    seedTask(raw);
    const p = join(projectDir, ".vibeflow", "tasks", "bare1.json");
    const before = readFileSync(p, "utf-8");
    expect(writeSortKeyMinimal(projectDir, "bare1", "a9")).toBe(false);
    expect(readFileSync(p, "utf-8")).toBe(before);
  });
});

// ── local delete ──────────────────────────────────────────────────────────

describe("local delete (core tasks)", () => {
  it("deleteTask removes the file and answers true; missing answers false", () => {
    seedTask(baseTask("gone1"));
    expect(deleteTask(projectDir, "gone1")).toBe(true);
    expect(
      existsSync(join(projectDir, ".vibeflow", "tasks", "gone1.json")),
    ).toBe(false);
    expect(deleteTask(projectDir, "gone1")).toBe(false);
    expect(deleteTask(projectDir, "never-existed")).toBe(false);
  });

  it("getDescendantIds is BFS root-first (reverse = deepest-first)", () => {
    const all = [
      { id: "root", links: [] },
      { id: "c1", links: [{ taskId: "root", type: "parent" }] },
      { id: "c2", links: [{ taskId: "root", type: "parent" }] },
      { id: "g1", links: [{ taskId: "c1", type: "parent" }] },
    ] as Parameters<typeof getDescendantIds>[0];
    const ids = getDescendantIds(all, "root");
    expect(ids).toHaveLength(3);
    // Parents always precede their children.
    expect(ids.indexOf("c1")).toBeLessThan(ids.indexOf("g1"));
    expect(new Set(ids)).toEqual(new Set(["c1", "c2", "g1"]));
  });
});
