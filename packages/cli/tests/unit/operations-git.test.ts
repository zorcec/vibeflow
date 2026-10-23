/**
 * Explicit-commit operation pins (ticket 4a5f7df6, P5 step 6).
 *
 * `commitTaskPathsOperation` is CLI-only (no MCP git tool by design),
 * driven here in local mode against disposable git repos:
 *
 * - unknown id → TASK_NOT_FOUND and nothing is committed or linked;
 * - ambiguous prefix → E_AMBIGUOUS naming the candidates, nothing written;
 * - dry-run previews the tagged message with zero effects (no commit, no
 *   record link, no push);
 * - explicit paths commit exactly those paths and leave foreign staged
 *   files in the index (never a bare `git commit` sweeping another lane);
 * - no pathspec scopes to the task record and reports foreign paths as
 *   left staged;
 * - a clean tree links HEAD instead of failing (never a dead end);
 * - an uncommittable pathspec is GIT_COMMIT_FAILED with the record
 *   untouched.
 *
 * The CLI envelopes, exit codes and human blocks over these results are
 * pinned by tests/e2e/tasks-commit-pathspec.test.ts against the built CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { OperationContext } from "../../src/core/operations.js";
import {
  commitTaskPathsOperation,
  tryAutoPush,
} from "../../src/core/operations.js";
import { gitEnvWithCleanLocation } from "../../src/core/git-env.js";

const gitEnv = gitEnvWithCleanLocation();

let projectDir: string;
let ctx: OperationContext;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "p5-git-"));
  ctx = { projectDir, mode: "local" };
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectDir,
    env: gitEnv,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
}

function initRepo(): void {
  git(["init", "-q"]);
  git(["config", "user.email", "p5-git@test.local"]);
  git(["config", "user.name", "P5"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
}

function head(): string {
  return git(["rev-parse", "HEAD"]).trim();
}

function commitCount(): number {
  return Number(git(["rev-list", "--count", "HEAD"]).trim());
}

/** Minimal task record in the date-subdir layout the store reads. */
function seedTask(id: string, extra: Record<string, unknown> = {}): string {
  const dateSubdir = new Date().toISOString().slice(0, 10);
  const tasksDir = join(projectDir, ".vibeflow", "tasks", dateSubdir);
  mkdirSync(tasksDir, { recursive: true });
  const rel = join(".vibeflow", "tasks", dateSubdir, `${id}.json`);
  writeFileSync(
    join(projectDir, rel),
    JSON.stringify({
      id,
      title: `Task ${id}`,
      description: "",
      status: "todo",
      selector: "/",
      created: new Date().toISOString(),
      commits: [],
      ...extra,
    }),
  );
  return rel;
}

function staged(): string[] {
  return git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
}

function readRecord(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectDir, rel), "utf-8")) as Record<
    string,
    unknown
  >;
}

describe("commitTaskPathsOperation", () => {
  it("refuses an unknown id with TASK_NOT_FOUND and commits nothing", async () => {
    initRepo();
    seedTask("real-task-000000000000000000000000000001");
    const before = head();
    const r = await commitTaskPathsOperation(ctx, { id: "ghost" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TASK_NOT_FOUND");
      expect(r.error.message).toContain("ghost");
    }
    expect(head()).toBe(before);
    expect(commitCount()).toBe(1);
  });

  it("refuses an ambiguous prefix with E_AMBIGUOUS naming the candidates", async () => {
    initRepo();
    seedTask("aaa111000000000000000000000000000001");
    seedTask("aaa222000000000000000000000000000002");
    const before = head();
    const r = await commitTaskPathsOperation(ctx, { id: "aaa" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("E_AMBIGUOUS");
      expect(r.error.message).toContain("aaa111");
      expect(r.error.message).toContain("aaa222");
    }
    expect(head()).toBe(before);
  });

  it("dry-run previews the tagged message with zero effects", async () => {
    initRepo();
    const rel = seedTask("dryrun00000000000000000000000000001");
    writeFileSync(join(projectDir, "work.txt"), "work\n");
    git(["add", "--", "work.txt"]);
    const bytesBefore = readFileSync(join(projectDir, rel), "utf-8");
    const before = head();
    const r = await commitTaskPathsOperation(ctx, {
      id: "dryrun",
      message: "do work",
      paths: ["work.txt"],
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.data.dryRun) {
      expect(r.data.message).toContain("do work");
      expect(r.data.message).toContain("dryrun");
      expect(r.data.taskId).toContain("dryrun");
    } else {
      expect.unreachable("expected a dry-run preview");
    }
    // Nothing committed, nothing linked, nothing staged away.
    expect(head()).toBe(before);
    expect(readFileSync(join(projectDir, rel), "utf-8")).toBe(bytesBefore);
    expect(staged()).toContain("work.txt");
  });

  it("commits only the explicit paths and leaves foreign staged files", async () => {
    initRepo();
    seedTask("explicit0000000000000000000000000001");
    writeFileSync(join(projectDir, "a.txt"), "A\n");
    writeFileSync(join(projectDir, "b.txt"), "B\n");
    git(["add", "--", "a.txt", "b.txt"]);
    const before = head();
    const r = await commitTaskPathsOperation(ctx, {
      id: "explicit",
      message: "commit A only",
      paths: ["a.txt"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.dryRun) expect.unreachable("expected a live commit");
    else {
      expect(r.data.linkedExisting).toBe(false);
      expect(r.data.committed).toEqual(["a.txt"]);
      expect(r.data.foreign).toEqual([]);
      expect(r.data.sha).not.toBe(before);
      expect(r.data.autoPush).toEqual({ attempted: false, ok: true });
    }
    // Never a bare `git commit`: the other lane's file stays staged.
    expect(
      execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
        cwd: projectDir,
        env: gitEnv,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .split("\n")
        .filter(Boolean),
    ).toEqual(["a.txt"]);
    expect(staged()).toContain("b.txt");
  });

  it("scopes to the task record with no pathspec and reports foreign as left staged", async () => {
    initRepo();
    const rel = seedTask("scoped00000000000000000000000000001");
    writeFileSync(join(projectDir, "foreign.txt"), "another lane\n");
    git(["add", "--", "foreign.txt", rel]);
    const r = await commitTaskPathsOperation(ctx, {
      id: "scoped",
      message: "task only",
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.dryRun) expect.unreachable("expected a live commit");
    else {
      expect(r.data.foreign).toContain("foreign.txt");
    }
    expect(staged()).toEqual(["foreign.txt"]);
    const record = readRecord(rel);
    expect((record.commits as Array<unknown>).length).toBe(1);
  });

  it("links HEAD instead of failing when the tree is clean", async () => {
    initRepo();
    const rel = seedTask("clean000000000000000000000000000001");
    git(["add", "--", rel]);
    git(["commit", "-q", "-m", "record task"]);
    const tip = head();
    const countBefore = commitCount();
    const r = await commitTaskPathsOperation(ctx, {
      id: "clean",
      message: "already committed",
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.dryRun) expect.unreachable("expected a live link");
    else {
      expect(r.data.linkedExisting).toBe(true);
      expect(r.data.sha).toBe(tip);
      expect(r.data.committed).toEqual([]);
    }
    expect(commitCount()).toBe(countBefore);
    const record = readRecord(rel);
    const commits = record.commits as Array<{ sha: string }>;
    expect(commits.length).toBe(1);
    expect(commits[0].sha).toBe(tip);
  });

  it("outside a git repo the commit refuses GIT_COMMIT_FAILED with the record untouched", async () => {
    // Deliberately no initRepo: git has no repository to read, so the
    // scoped commit cannot run — a zero-write refusal, not a partial save.
    const rel = seedTask("nogit000000000000000000000000000001");
    const bytesBefore = readFileSync(join(projectDir, rel), "utf-8");
    const r = await commitTaskPathsOperation(ctx, {
      id: "nogit",
      message: "nowhere to commit",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("GIT_COMMIT_FAILED");
    expect(readFileSync(join(projectDir, rel), "utf-8")).toBe(bytesBefore);
  });

  it("carries the task type so the renderer can warn on Research commits", async () => {
    initRepo();
    seedTask("research0000000000000000000000000001", { type: "Research" });
    const r = await commitTaskPathsOperation(ctx, {
      id: "research",
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.data.dryRun) expect.unreachable("expected a preview");
    else expect(r.data.taskType).toBe("Research");
  });

  it("defaults the message to the task title when --message is blank", async () => {
    initRepo();
    seedTask("blankmsg0000000000000000000000000001");
    const r = await commitTaskPathsOperation(ctx, {
      id: "blankmsg",
      message: "   ",
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.data.dryRun) expect.unreachable("expected a preview");
    else expect(r.data.message.startsWith("Task blankmsg")).toBe(true);
  });
});

describe("tryAutoPush (shared push effect)", () => {
  it("reports a failed push instead of throwing (no remote configured)", () => {
    initRepo();
    // Captured: git's chatter stays out of the test runner's stdout and
    // folds into the returned error string instead.
    const result = tryAutoPush(projectDir, { captureOutput: true });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});
