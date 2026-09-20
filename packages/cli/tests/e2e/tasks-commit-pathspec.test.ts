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
