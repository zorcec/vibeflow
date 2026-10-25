/**
 * Commit rewrite-window race (ticket 3d9a2b97).
 *
 * `vibeflow tasks --commit --task <id>` failed with
 * `Task file not found: <full id>` while `tasks --get <id>` resolved the
 * same ticket in the same second. The read path (`--get`) resolves through
 * the ONE shared snapshot rule (`resolveLocalTask`, reached via the store's
 * `resolveTask`); the commit path resolved the id and then re-derived a
 * concrete file path with a SECOND directory scan — and a third inside
 * `updateTask` — so any concurrent store rewrite (every task operation
 * rewrites files via tmp-file + atomic rename) in between made the commit
 * lose a race the read never ran.
 *
 * The tests below pin the contract:
 * - a transient rewrite-window miss between resolve and write still lands
 *   the commit (deterministic hook injection — no sleeps, no threads: the
 *   first resolution reports "missing" over a genuinely rewritten file,
 *   the retry then succeeds);
 * - `--get` and `--commit` share ONE resolver, so they cannot diverge
 *   again (bypassing the helper on either side fails);
 * - a genuinely missing id still errors, naming the id and the path tried.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, relative } from "node:path";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { commitTaskChanges, commitTaskPaths } from "../../src/core/git.js";
import * as tasksModule from "../../src/core/tasks.js";
import { getTasksDir } from "../../src/core/tasks.js";
import { localTaskStore } from "../../src/core/task-store.js";
import { gitEnvWithCleanLocation } from "../../src/core/git-env.js";

// Temp repos carry no hooks, but identities stay realistic anyway: the
// repo's Git identity guard refuses test/placeholder identities.
const gitEnv = gitEnvWithCleanLocation();
const GIT_NAME = "Project Contributor";
const GIT_EMAIL = "contributor@vibeflow.tools";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `git-race-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, env: gitEnv, stdio: "ignore" });
  execSync(`git config user.email '${GIT_EMAIL}'`, {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
  execSync(`git config user.name '${GIT_NAME}'`, {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
    cwd: dir,
    env: gitEnv,
    stdio: "ignore",
  });
}

function taskFilePath(dir: string, taskId: string): string {
  const dateSubdir = new Date().toISOString().slice(0, 10);
  return join(dir, ".vibeflow", "tasks", dateSubdir, `${taskId}.json`);
}

function createTaskFile(dir: string, taskId: string) {
  const tasksDir = join(
    dir,
    ".vibeflow",
    "tasks",
    new Date().toISOString().slice(0, 10),
  );
  mkdirSync(tasksDir, { recursive: true });
  const task = {
    id: taskId,
    title: "Race Test Task",
    description: "",
    status: "in-progress",
    selector: "/",
    created: new Date().toISOString(),
    commits: [],
  };
  writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify(task));
}

/**
 * A genuine store rewrite: tmp-file + atomic rename, exactly like
 * `writeTaskJson`. Merges `extra` into the persisted record.
 */
function rewriteTaskFile(dir: string, taskId: string, extra: object) {
  const path = taskFilePath(dir, taskId);
  const current = JSON.parse(readFileSync(path, "utf-8"));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...current, ...extra }));
  renameSync(tmp, path);
}

describe("commit rewrite window (ticket 3d9a2b97)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    initGitRepo(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("commitTaskPaths lands the commit when the file is rewritten between resolve and write", () => {
    const taskId = "race-task-001";
    createTaskFile(tmpDir, taskId);

    // Deterministic race injection (no sleeps, no threads): the FIRST
    // resolution runs over a genuinely rewritten file and reports the
    // transient miss the second scan used to die on; the retry then
    // resolves normally. Without the retry this fails with
    // "Task file not found" — the reported defect.
    const spy = vi.spyOn(tasksModule, "resolveLocalTask");
    spy.mockImplementationOnce((projectDir: string, idOrPrefix: string) => {
      rewriteTaskFile(projectDir, taskId, { priority: "High" });
      return { status: "missing" as const, id: taskId };
    });

    const result = commitTaskPaths(tmpDir, taskId, "race: rewrite window");
    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The commit landed AND the link is recorded on the rewritten file:
    // the rewrite-window read was retried, not lost.
    const task = JSON.parse(readFileSync(taskFilePath(tmpDir, taskId), "utf-8"));
    expect(task.priority).toBe("High");
    expect(task.commits).toHaveLength(1);
    expect(task.commits[0].sha).toBe(result.sha);
    expect(task.commits[0].message).toBe("race: rewrite window");
  });

  it("commitTaskChanges lands the commit when the file is rewritten between resolve and write", () => {
    const taskId = "race-task-002";
    createTaskFile(tmpDir, taskId);

    const spy = vi.spyOn(tasksModule, "resolveLocalTask");
    spy.mockImplementationOnce(() => {
      rewriteTaskFile(tmpDir, taskId, { priority: "High" });
      return { status: "missing" as const, id: taskId };
    });

    const result = commitTaskChanges(tmpDir, taskId, "race: changes path");
    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const task = JSON.parse(readFileSync(taskFilePath(tmpDir, taskId), "utf-8"));
    expect(task.priority).toBe("High");
    expect(task.commits).toHaveLength(1);
    expect(task.commits[0].sha).toBe(result.sha);
  });

  it("--get and --commit share one resolver, so they cannot diverge again", async () => {
    const taskId = "race-task-003";
    createTaskFile(tmpDir, taskId);

    // Both surfaces must funnel through the single local lookup. A change
    // that reintroduces a second scan on either side bypasses the spy and
    // fails here.
    const spy = vi.spyOn(tasksModule, "resolveLocalTask");

    const readOutcome = await localTaskStore.resolveTask(tmpDir, taskId);
    expect(readOutcome.status).toBe("found");
    expect(spy).toHaveBeenCalledWith(tmpDir, taskId);
    spy.mockClear();

    const writeResult = commitTaskPaths(tmpDir, taskId, "race: shared rule");
    expect(writeResult.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(tmpDir, taskId);
  });

  it("a genuinely missing id still errors, naming the id and the path tried", () => {
    const missingId = "ghost-race-00000000000000000001";

    for (const result of [
      commitTaskPaths(tmpDir, missingId, "race: ghost"),
      commitTaskChanges(tmpDir, missingId, "race: ghost"),
    ]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain(missingId);
      expect(result.error).toContain(getTasksDir(tmpDir));
    }
  });

  it("a short prefix resolves on the commit path exactly like --get", () => {
    const fullId = "race-prefix-aaaabbbbccccddddeeeeffff0001";
    createTaskFile(tmpDir, fullId);
    const short = fullId.slice(0, 12);

    // The read rule resolves the unique prefix…
    const read = tasksModule.findTaskByIdOrPrefix(tmpDir, short);
    expect(read?.id).toBe(fullId);

    // …and the commit path resolves it to the same record, not "not found".
    const relTask = relative(tmpDir, taskFilePath(tmpDir, fullId));
    execFileSync("git", ["add", "--", relTask], {
      cwd: tmpDir,
      env: gitEnv,
      stdio: "ignore",
    });
    const result = commitTaskPaths(tmpDir, short, "race: prefix commit");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = JSON.parse(readFileSync(taskFilePath(tmpDir, fullId), "utf-8"));
    expect(task.commits).toHaveLength(1);
    expect(task.commits[0].sha).toBe(result.sha);
  });
});
