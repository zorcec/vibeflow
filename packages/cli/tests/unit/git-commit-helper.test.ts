import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { commitTaskChanges } from "../../src/core/git.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `git-helper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });
}

function createTaskFile(dir: string, taskId: string, commits: Array<{ sha: string; message: string; timestamp: string }> = []) {
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

describe("commitTaskChanges", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("commits staged changes and returns SHA", () => {
    const taskId = "test-task-001";
    createTaskFile(tmpDir, taskId);
    // Stage a file
    writeFileSync(join(tmpDir, "test.txt"), "hello");
    execSync("git add test.txt", { cwd: tmpDir, stdio: "ignore" });

    const result = commitTaskChanges(tmpDir, taskId, "feat: add test file");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("appends commit record to task file", () => {
    const taskId = "test-task-002";
    createTaskFile(tmpDir, taskId);
    writeFileSync(join(tmpDir, "file2.txt"), "content");
    execSync("git add file2.txt", { cwd: tmpDir, stdio: "ignore" });

    const result = commitTaskChanges(tmpDir, taskId, "fix: something");
    expect(result.ok).toBe(true);

    // Read the task file and verify commits were appended
    const dateSubdir = new Date().toISOString().slice(0, 10);
    const taskPath = join(tmpDir, ".vibeflow", "tasks", dateSubdir, `${taskId}.json`);
    const task = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(task.commits).toHaveLength(1);
    expect(task.commits[0].message).toBe("fix: something");
    expect(task.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    expect(task.commits[0].timestamp).toBeDefined();
  });

  it("uses [proto:<id>] tag in commit message", () => {
    const taskId = "test-task-003";
    createTaskFile(tmpDir, taskId);
    writeFileSync(join(tmpDir, "file3.txt"), "data");
    execSync("git add file3.txt", { cwd: tmpDir, stdio: "ignore" });

    const result = commitTaskChanges(tmpDir, taskId, "chore: update");
    expect(result.ok).toBe(true);

    // Check the git log for the proto tag
    const log = execSync("git log --oneline -1", { cwd: tmpDir }).toString();
    expect(log).toContain(`[proto:${taskId}]`);
  });

  it("returns error when no staged changes", () => {
    const taskId = "test-task-004";
    createTaskFile(tmpDir, taskId);
    // Nothing staged

    const result = commitTaskChanges(tmpDir, taskId, "empty commit");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeDefined();
    }
  });

  it("appends to existing commits array", () => {
    const taskId = "test-task-005";
    const existingCommits = [
      { sha: "abc123", message: "first commit", timestamp: "2026-01-01T00:00:00Z" },
    ];
    createTaskFile(tmpDir, taskId, existingCommits);
    writeFileSync(join(tmpDir, "file5.txt"), "data");
    execSync("git add file5.txt", { cwd: tmpDir, stdio: "ignore" });

    const result = commitTaskChanges(tmpDir, taskId, "second commit");
    expect(result.ok).toBe(true);

    const dateSubdir = new Date().toISOString().slice(0, 10);
    const taskPath = join(tmpDir, ".vibeflow", "tasks", dateSubdir, `${taskId}.json`);
    const task = JSON.parse(readFileSync(taskPath, "utf-8"));
    expect(task.commits).toHaveLength(2);
    expect(task.commits[0].sha).toBe("abc123");
    expect(task.commits[1].message).toBe("second commit");
  });
});
