/**
 * CLI e2e — `tasks --add --parent <task-id>`.
 *
 * A task can be created as a child in one command. `--parent` is an
 * `--add`-only option, accepts a full id or unique prefix, and rejects a
 * dangling target without writing a task file.
 *
 * Runs against the built bundle (dist/index.js) in temp dirs only — no real
 * task store is touched.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
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

interface AddResult {
  task: {
    id: string;
    title: string;
    links?: Array<{ taskId: string; type: string }>;
  };
}

async function addTask(
  store: string,
  home: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return spawnCli(["tasks", store, ...args], { cwd: store, home });
}

/** All task JSON files under the store's task dir (flat + date-subdir layouts). */
function taskFiles(store: string): string[] {
  const tasksDir = join(store, ".vibeflow", "tasks");
  if (!existsSync(tasksDir)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) out.push(full);
    }
  };
  walk(tasksDir);
  return out;
}

describe("tasks --add --parent", () => {
  it("creates a child link with a full parent id", async () => {
    const store = freshDir("parent-store-");
    const home = freshDir("parent-home-");

    const parent = await addTask(store, home, [
      "--add",
      "--title",
      "Parent",
      "--json",
    ]);
    expect(parent.code).toBe(0);
    const parentId = (JSON.parse(parent.stdout) as AddResult).task.id;

    const child = await addTask(store, home, [
      "--add",
      "--title",
      "Child",
      "--parent",
      parentId,
      "--json",
    ]);
    expect(child.code).toBe(0);
    const parsed = JSON.parse(child.stdout) as AddResult;

    // json output carries both the new id and the parent field
    expect(parsed.task.id).toMatch(/^[a-f0-9]{30}$/);
    expect(parsed.task.links).toEqual([{ taskId: parentId, type: "parent" }]);

    // persisted on disk
    const childId = parsed.task.id;
    const file = taskFiles(store).find((f) => f.endsWith(`${childId}.json`));
    expect(file).toBeDefined();
    const raw = JSON.parse(readFileSync(file!, "utf-8")) as AddResult["task"];
    expect(raw.links).toEqual([{ taskId: parentId, type: "parent" }]);
  });

  it("resolves a unique prefix to the full parent id", async () => {
    const store = freshDir("parent-store-");
    const home = freshDir("parent-home-");

    const parent = await addTask(store, home, [
      "--add",
      "--title",
      "Parent",
      "--json",
    ]);
    const parentId = (JSON.parse(parent.stdout) as AddResult).task.id;

    const child = await addTask(store, home, [
      "--add",
      "--title",
      "Child",
      "--parent",
      parentId.slice(0, 8),
      "--json",
    ]);
    expect(child.code).toBe(0);
    const parsed = JSON.parse(child.stdout) as AddResult;
    expect(parsed.task.links).toEqual([{ taskId: parentId, type: "parent" }]);
  });

  it("errors with a helpful message when --parent is used without --add", async () => {
    const store = freshDir("parent-store-");
    const home = freshDir("parent-home-");

    const parent = await addTask(store, home, [
      "--add",
      "--title",
      "Parent",
      "--json",
    ]);
    const parentId = (JSON.parse(parent.stdout) as AddResult).task.id;

    const res = await addTask(store, home, ["--parent", parentId, "--json"]);
    expect(res.code).not.toBe(0);
    const envelope = JSON.parse(res.stderr) as {
      error: { message: string; suggestion?: string };
    };
    expect(envelope.error.message).toBe("--parent is only valid with --add");
    expect(envelope.error.suggestion).toContain("--add");
    expect(envelope.error.suggestion).toContain("--parent");

    // human-readable path mirrors the same message
    const human = await addTask(store, home, ["--parent", parentId]);
    expect(human.code).not.toBe(0);
    expect(human.stdout + human.stderr).toContain(
      "--parent is only valid with --add",
    );
  });

  it("errors on a nonexistent parent and writes no task file", async () => {
    const store = freshDir("parent-store-");
    const home = freshDir("parent-home-");

    const before = taskFiles(store).length;
    const res = await addTask(store, home, [
      "--add",
      "--title",
      "Orphan",
      "--parent",
      "deadbeefdeadbeef",
      "--json",
    ]);

    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toContain(
      "Parent task not found: deadbeefdeadbeef",
    );
    expect(taskFiles(store).length).toBe(before);
  });

  it("rejects an unknown id as a parent (a new task cannot reference its own future id)", async () => {
    // The new task's id is generated at create time, so it cannot be supplied
    // as its own parent; any id that is not an existing task is dangling.
    const store = freshDir("parent-store-");
    const home = freshDir("parent-home-");

    const res = await addTask(store, home, [
      "--add",
      "--title",
      "Self",
      "--parent",
      "000000000000000000000000000000",
      "--json",
    ]);
    expect(res.code).not.toBe(0);
    expect(res.stdout + res.stderr).toContain("Parent task not found");
    expect(taskFiles(store)).toHaveLength(0);
  });

  it("still creates a standalone task without --parent", async () => {
    const store = freshDir("parent-store-");
    const home = freshDir("parent-home-");

    const res = await addTask(store, home, [
      "--add",
      "--title",
      "Standalone",
      "--json",
    ]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as AddResult;
    expect(parsed.task.id).toMatch(/^[a-f0-9]{30}$/);
    expect(parsed.task.links).toBeUndefined();
    expect(taskFiles(store)).toHaveLength(1);
  });
});
