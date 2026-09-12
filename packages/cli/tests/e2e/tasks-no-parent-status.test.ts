/**
 * CLI e2e — `tasks --edit <id> --no-parent` must not change the task status.
 *
 * Reported symptom (task 3e9f447d): running `tasks --edit <id> --no-parent`
 * cleared the parent link but also set the status to `done`. No live defect was
 * found — the unit-level regression in tasks-no-parent-status.test.ts replays
 * the clear-parent *composition*, which would not catch a regression that wrote
 * `status` directly in the CLI command branch or in Commander option parsing.
 *
 * This test closes that gap by spawning the real built CLI (`dist/index.js`)
 * and asserting on the task file on disk: only the parent link changes.
 *
 * Runs against the built bundle in temp dirs only — no real task store is
 * touched.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCli } from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

interface StoredTask {
  id: string;
  status?: string;
  title?: string;
  links?: Array<{ taskId: string; type: string }>;
}

/** Read every persisted task JSON under the temp store. */
function readStore(store: string): StoredTask[] {
  const tasksDir = join(store, ".vibeflow", "tasks");
  const out: StoredTask[] = [];
  let dateDirs: string[];
  try {
    dateDirs = readdirSync(tasksDir);
  } catch {
    return out;
  }
  for (const dateDir of dateDirs) {
    const dayPath = join(tasksDir, dateDir);
    let files: string[];
    try {
      files = readdirSync(dayPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      out.push(
        JSON.parse(readFileSync(join(dayPath, f), "utf-8")) as StoredTask,
      );
    }
  }
  return out;
}

function byId(store: string, id: string): StoredTask | undefined {
  return readStore(store).find((t) => t.id.startsWith(id));
}

function parentIdOf(task: StoredTask | undefined): string | undefined {
  return task?.links?.find((l) => l.type === "parent")?.taskId;
}

/** Create a task (optionally as a child) via the real CLI; return its id. */
async function createTask(
  store: string,
  home: string,
  title: string,
  parent?: string,
): Promise<string> {
  const args = [
    "tasks",
    "--add",
    "--title",
    title,
    "--json",
    ...(parent ? ["--parent", parent] : []),
  ];
  const res = await spawnCli(args, { cwd: store, home });
  expect(res.code, `add failed: ${res.stderr}`).toBe(0);
  const created = readStore(store).find((t) => t.title === title);
  expect(created, `task "${title}" not found after add`).toBeDefined();
  return created!.id;
}

async function setStatus(
  store: string,
  home: string,
  id: string,
  status: string,
): Promise<void> {
  const res = await spawnCli(
    ["tasks", "--edit", id, "--set-status", status],
    { cwd: store, home },
  );
  expect(res.code, `set-status failed: ${res.stderr}`).toBe(0);
}

describe("e2e: tasks --edit --no-parent preserves status", () => {
  it("clears the parent link but leaves status todo", async () => {
    const store = freshDir("vf-noparent-todo-");
    const home = freshDir("vf-noparent-home-");

    const parentId = await createTask(store, home, "parent task");
    const childId = await createTask(store, home, "child task", parentId);

    // Precondition: the child really is parented and is todo.
    const before = byId(store, childId);
    expect(parentIdOf(before), "child should start parented").toBe(parentId);
    expect(before?.status).toBe("todo");

    const res = await spawnCli(
      ["tasks", "--edit", childId, "--no-parent"],
      { cwd: store, home },
    );
    expect(res.code, `--no-parent failed: ${res.stderr}`).toBe(0);

    const after = byId(store, childId);
    expect(parentIdOf(after), "parent link should be cleared").toBeUndefined();
    expect(after?.status, "status must NOT change").toBe("todo");
    expect(after?.status, "status must not be done").not.toBe("done");
  });

  it("keeps an in-progress task in-progress", async () => {
    const store = freshDir("vf-noparent-prog-");
    const home = freshDir("vf-noparent-home-");

    const parentId = await createTask(store, home, "parent task");
    const childId = await createTask(store, home, "child task", parentId);
    await setStatus(store, home, childId, "in-progress");

    const res = await spawnCli(
      ["tasks", "--edit", childId, "--no-parent"],
      { cwd: store, home },
    );
    expect(res.code, `--no-parent failed: ${res.stderr}`).toBe(0);

    const after = byId(store, childId);
    expect(parentIdOf(after)).toBeUndefined();
    expect(after?.status, "status must remain in-progress").toBe("in-progress");
  });

  it("--set-parent \"\" also preserves status", async () => {
    const store = freshDir("vf-noparent-empty-");
    const home = freshDir("vf-noparent-home-");

    const parentId = await createTask(store, home, "parent task");
    const childId = await createTask(store, home, "child task", parentId);

    const res = await spawnCli(
      ["tasks", "--edit", childId, "--set-parent", ""],
      { cwd: store, home },
    );
    expect(res.code, `--set-parent "" failed: ${res.stderr}`).toBe(0);

    const after = byId(store, childId);
    expect(parentIdOf(after)).toBeUndefined();
    expect(after?.status).toBe("todo");
  });
});
