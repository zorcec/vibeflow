import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import { join, relative } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { commitTaskChanges, commitTaskPaths } from "../../src/core/git.js";
import { gitEnvWithCleanLocation } from "../../src/core/git-env.js";

// Git exports repo-location vars (GIT_DIR, GIT_WORK_TREE, …) to hooks such as
// the repo pre-commit hook that runs this suite. Inheriting them makes every
// `git` command below ignore its `cwd` and write into the real repository.
const gitEnv = gitEnvWithCleanLocation();

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `git-helper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, env: gitEnv, stdio: "ignore" });
  execSync("git config user.email 'test@test.com'", {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
  execSync("git config user.name 'Test'", {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
}

/** Creates the initial commit so `HEAD` exists for the nothing-to-commit cases. */
function initialCommit(dir: string) {
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
}

function headSha(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, env: gitEnv })
    .toString()
    .trim();
}

function taskFilePath(dir: string, taskId: string): string {
  const dateSubdir = new Date().toISOString().slice(0, 10);
  return join(dir, ".vibeflow", "tasks", dateSubdir, `${taskId}.json`);
}

function createTaskFile(
  dir: string,
  taskId: string,
  commits: Array<{ sha: string; message: string; timestamp: string }> = [],
) {
  const now = new Date();
  const dateSubdir = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const tasksDir = join(dir, ".vibeflow", "tasks", dateSubdir);
  mkdirSync(tasksDir, { recursive: true });
  const task = {
    id: taskId,
    title: "Git Helper Test Task",
    description: "",
    status: "in-progress" as const,
    type: "Task" as const,
    priority: "Medium" as const,
    selector: "/",
    created: new Date().toISOString(),
    commits,
  };
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify(task));
  return task;
}

/** Stage an exact path (never `git add -A`). */
function stage(dir: string, relPath: string) {
  execFileSync("git", ["add", "--", relPath], {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
}

/** Files in the latest commit, one repo-relative path per line. */
function committedFiles(dir: string): string[] {
  return execSync("git show --name-only --format= HEAD", {
    cwd: dir,
    env: gitEnv,
  })
    .toString()
    .split("\n")
    .filter(Boolean);
}

function stagedFiles(dir: string): string[] {
  return execSync("git diff --cached --name-only", { cwd: dir, env: gitEnv })
    .toString()
    .split("\n")
    .filter(Boolean);
}

describe("commitTaskChanges", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("commits the task's own staged file and returns SHA", () => {
    const taskId = "test-task-001";
    createTaskFile(tmpDir, taskId);
    stage(tmpDir, relative(tmpDir, taskFilePath(tmpDir, taskId)));

    const result = commitTaskChanges(tmpDir, taskId, "feat: add test file");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("appends commit record to task file", () => {
    const taskId = "test-task-002";
    createTaskFile(tmpDir, taskId);
    stage(tmpDir, relative(tmpDir, taskFilePath(tmpDir, taskId)));

    const result = commitTaskChanges(tmpDir, taskId, "fix: something");
    expect(result.ok).toBe(true);

    // Read the task file and verify commits were appended
    const task = JSON.parse(
      readFileSync(taskFilePath(tmpDir, taskId), "utf-8"),
    );
    expect(task.commits).toHaveLength(1);
    expect(task.commits[0].message).toBe("fix: something");
    expect(task.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(task.commits[0].timestamp).toBeDefined();
  });

  it("uses [proto:<id>] tag in commit message", () => {
    const taskId = "test-task-003";
    createTaskFile(tmpDir, taskId);
    stage(tmpDir, relative(tmpDir, taskFilePath(tmpDir, taskId)));

    const result = commitTaskChanges(tmpDir, taskId, "chore: update");
    expect(result.ok).toBe(true);

    // Check the git log for the proto tag
    const log = execSync("git log --oneline -1", {
      cwd: tmpDir,
      env: gitEnv,
    }).toString();
    expect(log).toContain(`[proto:${taskId}]`);
  });

  it("returns error when the task's own file is not staged", () => {
    const taskId = "test-task-004";
    createTaskFile(tmpDir, taskId);
    // Nothing staged — and a foreign staged file must NOT make the commit succeed.
    writeFileSync(join(tmpDir, "foreign.txt"), "another lane's work");
    stage(tmpDir, "foreign.txt");

    const result = commitTaskChanges(tmpDir, taskId, "empty commit");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(taskId);
      expect(result.error).toContain("git add");
    }
  });

  it("appends to existing commits array", () => {
    const taskId = "test-task-005";
    const existingCommits = [
      {
        sha: "abc123",
        message: "first commit",
        timestamp: "2026-01-01T00:00:00Z",
      },
    ];
    createTaskFile(tmpDir, taskId, existingCommits);
    stage(tmpDir, relative(tmpDir, taskFilePath(tmpDir, taskId)));

    const result = commitTaskChanges(tmpDir, taskId, "second commit");
    expect(result.ok).toBe(true);

    const task = JSON.parse(
      readFileSync(taskFilePath(tmpDir, taskId), "utf-8"),
    );
    expect(task.commits).toHaveLength(2);
    expect(task.commits[0].sha).toBe("abc123");
    expect(task.commits[1].message).toBe("second commit");
  });

  // Regression for the shared-index corruption: two lanes share one index, so a
  // plain `git commit` swept lane A's staged file into lane B's commit.
  it("does not sweep another lane's staged file into the commit", () => {
    const taskId = "test-task-006";
    createTaskFile(tmpDir, taskId);

    // Lane A stages its own unrelated file.
    writeFileSync(join(tmpDir, "lane-a.txt"), "lane A work");
    stage(tmpDir, "lane-a.txt");
    // Lane B stages its task file.
    const relTask = relative(tmpDir, taskFilePath(tmpDir, taskId));
    stage(tmpDir, relTask);

    const result = commitTaskChanges(tmpDir, taskId, "task B only");
    expect(result.ok).toBe(true);

    // The commit contains ONLY lane B's task file — not lane A's file.
    expect(committedFiles(tmpDir)).toEqual([relTask]);
    // Lane A's file is still staged, untouched, for its own owner to commit.
    expect(stagedFiles(tmpDir)).toContain("lane-a.txt");
  });

  it("commits staged screenshots under the task's attachment directory", () => {
    const taskId = "test-task-007";
    createTaskFile(tmpDir, taskId);
    const filesDir = join(tmpDir, ".vibeflow", "tasks", "files", taskId);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "shot.png"), "png-bytes");

    const relTask = relative(tmpDir, taskFilePath(tmpDir, taskId));
    const relShot = relative(tmpDir, join(filesDir, "shot.png"));
    stage(tmpDir, relTask);
    stage(tmpDir, relShot);

    const result = commitTaskChanges(tmpDir, taskId, "task + screenshot");
    expect(result.ok).toBe(true);

    const committed = committedFiles(tmpDir).sort();
    expect(committed).toEqual([relShot, relTask].sort());
  });
});

describe("commitTaskPaths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    initGitRepo(tmpDir);
    initialCommit(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("commits only the explicit paths and leaves other staged paths alone", () => {
    const taskId = "paths-task-001";
    createTaskFile(tmpDir, taskId);
    writeFileSync(join(tmpDir, "a.txt"), "lane A content");
    writeFileSync(join(tmpDir, "b.txt"), "lane B content");
    stage(tmpDir, "a.txt");
    stage(tmpDir, "b.txt");

    const result = commitTaskPaths(tmpDir, taskId, "commit a only", ["a.txt"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.linkedExisting).toBe(false);
      expect(result.committed).toEqual(["a.txt"]);
      expect(result.foreign).toEqual([]);
    }

    // Only a.txt is in the commit; b.txt stays staged for its own owner.
    expect(committedFiles(tmpDir)).toEqual(["a.txt"]);
    expect(stagedFiles(tmpDir)).toContain("b.txt");
  });

  it("commits only the task's own record when no paths are given", () => {
    const taskId = "paths-task-002";
    createTaskFile(tmpDir, taskId);
    const relTask = relative(tmpDir, taskFilePath(tmpDir, taskId));
    stage(tmpDir, relTask);

    // Another lane's staged file must be reported and left in the index.
    writeFileSync(join(tmpDir, "foreign.txt"), "another lane's work");
    stage(tmpDir, "foreign.txt");

    const result = commitTaskPaths(tmpDir, taskId, "task record only");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.linkedExisting).toBe(false);
      expect(result.committed).toEqual([relTask]);
      expect(result.foreign).toEqual(["foreign.txt"]);
    }

    expect(committedFiles(tmpDir)).toEqual([relTask]);
    expect(stagedFiles(tmpDir)).toContain("foreign.txt");
  });

  it("links existing HEAD instead of failing when the tree is clean", () => {
    const taskId = "paths-task-003";
    createTaskFile(tmpDir, taskId);
    const before = headSha(tmpDir);

    const result = commitTaskPaths(tmpDir, taskId, "nothing new");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.linkedExisting).toBe(true);
      expect(result.sha).toBe(before);
      expect(result.committed).toEqual([]);
    }

    // No new commit was created, but the task still carries the linked SHA.
    expect(headSha(tmpDir)).toBe(before);
    const task = JSON.parse(
      readFileSync(taskFilePath(tmpDir, taskId), "utf-8"),
    );
    expect(task.commits).toHaveLength(1);
    expect(task.commits[0].sha).toBe(before);
  });

  it("links existing HEAD when explicit paths have no changes", () => {
    const taskId = "paths-task-004";
    createTaskFile(tmpDir, taskId);
    writeFileSync(join(tmpDir, "tracked.txt"), "original");
    stage(tmpDir, "tracked.txt");
    execFileSync("git", ["commit", "-m", "add tracked", "--", "tracked.txt"], {
      cwd: tmpDir,
      env: gitEnv,
      stdio: "ignore",
    });
    const before = headSha(tmpDir);

    const result = commitTaskPaths(tmpDir, taskId, "no changes", [
      "tracked.txt",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.linkedExisting).toBe(true);
      expect(result.sha).toBe(before);
    }
    expect(headSha(tmpDir)).toBe(before);
  });
});
