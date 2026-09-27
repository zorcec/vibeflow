/**
 * CLI e2e — `tasks --commit` is path-scoped and never dead-ends.
 *
 * Every lane shares one git index, so a bare `git commit` would sweep whatever
 * another lane staged into this task's commit. The command must commit only the
 * task's own record (no paths) or exactly the paths after `--`, leave every other
 * staged path in the index, and link the existing HEAD instead of failing when
 * there is nothing to commit.
 *
 * Runs against the built bundle (dist/index.js) in temp dirs only.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { spawnCli } from "./mcp-helpers.js";
import { gitEnvWithCleanLocation } from "../../src/core/git-env.js";

const cleanups: Array<() => void> = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const gitEnv = gitEnvWithCleanLocation();

/** Runs a git command in `dir` and returns its stdout. */
function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: gitEnv,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "e2e@test.local"]);
  git(dir, ["config", "user.name", "E2E"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "init"]);
}

/** Writes a minimal task record directly (the store is a temp dir, not the CLI). */
function seedTask(store: string, id: string): string {
  const dateSubdir = new Date().toISOString().slice(0, 10);
  const tasksDir = join(store, ".vibeflow", "tasks", dateSubdir);
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(
    join(tasksDir, `${id}.json`),
    JSON.stringify({
      id,
      title: "Path-scoped commit e2e",
      description: "",
      status: "in-progress",
      type: "Task",
      priority: "Medium",
      selector: "/",
      created: new Date().toISOString(),
      commits: [],
    }),
  );
  return join(".vibeflow", "tasks", dateSubdir, `${id}.json`);
}

/** Repo-relative paths still staged in the index. */
function stagedFiles(dir: string): string[] {
  return git(dir, ["diff", "--cached", "--name-only"])
    .split("\n")
    .filter(Boolean);
}

/** Repo-relative paths in the latest commit. */
function committedFiles(dir: string): string[] {
  return git(dir, ["show", "--name-only", "--format=", "HEAD"])
    .split("\n")
    .filter(Boolean);
}

/** Turns auto-push on in the store's settings. */
function enableAutoPush(store: string): void {
  mkdirSync(join(store, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(store, ".vibeflow", "settings.json"),
    JSON.stringify({ autoCommit: true, autoComment: true, autoPush: true }),
    "utf-8",
  );
}

describe("tasks --commit pathspec", () => {
  it("commits only the task's own record and leaves a foreign staged file", async () => {
    const store = freshDir("commit-lanes-");
    const home = freshDir("commit-home-");
    const id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    initRepo(store);
    const taskRel = seedTask(store, id);
    writeFileSync(join(store, "foreign.txt"), "another lane's work");
    git(store, ["add", "--", "foreign.txt"]);
    git(store, ["add", "--", taskRel]);

    const { stdout, code } = await spawnCli(
      ["tasks", store, "--commit", "--task", id, "--message", "chore: task only"],
      { cwd: store, home },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("foreign.txt");
    expect(stdout).toContain("left in the index");
    expect(committedFiles(store)).toEqual([taskRel]);
    expect(stagedFiles(store)).toContain("foreign.txt");
  });

  it("commits only the explicit paths after --", async () => {
    const store = freshDir("commit-paths-");
    const home = freshDir("commit-home-");
    const id = "ffffffffffffffffffffffffffffffff";
    initRepo(store);
    seedTask(store, id);
    writeFileSync(join(store, "a.txt"), "A");
    writeFileSync(join(store, "b.txt"), "B");
    git(store, ["add", "--", "a.txt", "b.txt"]);

    const { stdout, code } = await spawnCli(
      [
        "tasks",
        store,
        "--commit",
        "--task",
        id,
        "--message",
        "commit A only",
        "--",
        "a.txt",
      ],
      { cwd: store, home },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Committed and linked to task");
    expect(committedFiles(store)).toEqual(["a.txt"]);
    expect(stagedFiles(store)).toContain("b.txt");
  });

  it("links the existing HEAD instead of dead-ending on a clean tree", async () => {
    const store = freshDir("commit-clean-");
    const home = freshDir("commit-home-");
    const id = "11111111111111111111111111111111";
    initRepo(store);
    const taskRel = seedTask(store, id);
    git(store, ["add", "--", taskRel]);
    git(store, ["commit", "-q", "-m", "record task"]);
    const head = git(store, ["rev-parse", "HEAD"]).trim();

    const { stdout, code } = await spawnCli(
      ["tasks", store, "--commit", "--task", id, "--message", "already committed"],
      { cwd: store, home },
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Nothing to commit");
    expect(stdout).toContain("Linked existing commit");
    expect(git(store, ["rev-parse", "HEAD"]).trim()).toBe(head);
    const task = JSON.parse(
      readFileSync(join(store, taskRel), "utf-8"),
    ) as { commits: Array<{ sha: string }> };
    expect(task.commits).toHaveLength(1);
    expect(task.commits[0].sha).toBe(head);
  });
});

/**
 * `--json` suppresses the auto-push PROGRESS, never the auto-push itself.
 *
 * The bug this pins: the guard that keeps stdout parseable was written as a
 * condition on the `tryAutoPush` CALL instead of on the `console.log` calls
 * around it, so `tasks --commit --json` quietly stopped pushing. Stdout is
 * still clean either way — a test that only asserted "no prose printed" would
 * have passed against the broken version. So these tests assert the OUTCOME: a
 * real remote really received the commit, and a real failure really comes back
 * in the payload.
 */
describe("tasks --commit --json still auto-pushes", () => {
  it("pushes the commit to the remote and reports the push in the payload", async () => {
    const store = freshDir("commit-push-store-");
    const home = freshDir("commit-push-home-");
    const remote = freshDir("commit-push-remote-");
    const id = "22222222222222222222222222222222";
    initRepo(store);
    git(remote, ["init", "-q", "--bare"]);
    git(store, ["remote", "add", "origin", remote]);
    enableAutoPush(store);
    const taskRel = seedTask(store, id);
    git(store, ["add", "--", taskRel]);
    const branch = git(store, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();

    const { stdout, code } = await spawnCli(
      ["tasks", store, "--commit", "--task", id, "--message", "fix: push me", "--json"],
      { cwd: store, home },
    );

    expect(code).toBe(0);
    // The push really happened — the remote has the commit this run made.
    expect(git(remote, ["rev-parse", `refs/heads/${branch}`]).trim()).toBe(
      git(store, ["rev-parse", "HEAD"]).trim(),
    );
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      autoPush: { attempted: boolean; ok: boolean; error?: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.autoPush).toEqual({ attempted: true, ok: true });
    // …and stdout still carries the one document, with no push prose in it.
    expect(stdout).not.toContain("auto-push");
    expect(stdout).not.toContain("Pushed");
  });

  it("surfaces a failed auto-push in the payload, not on stdout", async () => {
    const store = freshDir("commit-pushfail-store-");
    const home = freshDir("commit-pushfail-home-");
    const id = "33333333333333333333333333333333";
    // A repo with no remote at all: the push is attempted and fails.
    initRepo(store);
    enableAutoPush(store);
    const taskRel = seedTask(store, id);
    git(store, ["add", "--", taskRel]);

    const { stdout, code } = await spawnCli(
      ["tasks", store, "--commit", "--task", id, "--message", "fix: unpushable", "--json"],
      { cwd: store, home },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      autoPush: { attempted: boolean; ok: boolean; error?: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.autoPush.attempted).toBe(true);
    expect(payload.autoPush.ok).toBe(false);
    expect(typeof payload.autoPush.error).toBe("string");
    expect(stdout).not.toContain("Auto-push failed");
    expect(stdout).not.toContain("auto-push");
  });
});
