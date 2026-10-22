/**
 * CLI e2e — `vibeflow tasks --attach` in local (offline) mode.
 *
 * Spawns the real built CLI (`dist/index.js`) in temp stores with an
 * isolated HOME (no token → local mode) and asserts on exit codes, output,
 * and the persisted task + file state on disk.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
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

/** Seed a git identity and non-interfering settings for an offline store. */
function seedStore(store: string): void {
  execSync(
    "git init -q && git config user.name 'E2E User' && git config user.email 'e2e@test.local'",
    { cwd: store, stdio: "ignore" },
  );
  mkdirSync(join(store, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(store, ".vibeflow", "settings.json"),
    JSON.stringify({ autoCommit: false, autoComment: false, autoPush: false }),
  );
}

/** Create a task through the real CLI and return its full id. */
async function addTask(store: string, home: string): Promise<string> {
  const r = await spawnCli(
    ["tasks", store, "--add", "--title", "Attach target", "--json"],
    { cwd: store, home },
  );
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout).task.id as string;
}

function filesOnDisk(store: string, taskId: string): string[] {
  const dir = join(store, ".vibeflow", "tasks", "files", taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function taskStatus(store: string, taskId: string): string {
  const tasksDir = join(store, ".vibeflow", "tasks");
  for (const entry of readdirSync(tasksDir)) {
    const candidate = join(tasksDir, entry, `${taskId}.json`);
    if (existsSync(candidate)) {
      return (JSON.parse(readFileSync(candidate, "utf-8")) as { status: string })
        .status;
    }
  }
  throw new Error(`task file missing for ${taskId}`);
}

describe("tasks --attach (local mode)", () => {
  it("attaches a file, prints the file id, keeps the source, and leaves status alone", async () => {
    const store = freshDir("attach-store-");
    const home = freshDir("attach-home-");
    seedStore(store);
    const id = await addTask(store, home);
    const source = join(store, "plan.md");
    writeFileSync(source, "# plan\n");

    const r = await spawnCli(["tasks", store, "--attach", source, "--task", id], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plan.md");
    expect(r.stdout).toMatch(/file id/i);
    // Source is kept by default.
    expect(existsSync(source)).toBe(true);
    // File lands where the local store expects it, with one ref.
    expect(filesOnDisk(store, id)).toEqual(["plan.md"]);
    expect(readFileSync(join(store, ".vibeflow", "tasks", "files", id, "plan.md"), "utf-8")).toBe(
      "# plan\n",
    );
    // Any task type, no status change.
    expect(taskStatus(store, id)).toBe("todo");
  });

  it("resolves a unique id prefix and answers --json {ok,taskId,fileId,name,size}", async () => {
    const store = freshDir("attach-json-");
    const home = freshDir("attach-json-home-");
    seedStore(store);
    const id = await addTask(store, home);
    const source = join(store, "notes.md");
    writeFileSync(source, "notes body");

    const r = await spawnCli(
      ["tasks", store, "--attach", source, "--task", id.slice(0, 8), "--json"],
      { cwd: store, home },
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      taskId: id,
      fileId: "notes.md",
      name: "notes.md",
      size: Buffer.byteLength("notes body"),
    });
  });

  it("refuses the same (task, name) pair twice with E_FILE_EXISTS", async () => {
    const store = freshDir("attach-dup-");
    const home = freshDir("attach-dup-home-");
    seedStore(store);
    const id = await addTask(store, home);
    const source = join(store, "plan.md");
    writeFileSync(source, "v1");

    const first = await spawnCli(
      ["tasks", store, "--attach", source, "--task", id, "--json"],
      { cwd: store, home },
    );
    expect(first.code).toBe(0);

    const second = await spawnCli(
      ["tasks", store, "--attach", source, "--task", id, "--json"],
      { cwd: store, home },
    );
    expect(second.code).toBe(2);
    const err = JSON.parse(second.stderr) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe("E_FILE_EXISTS");
    expect(err.error.message).toContain("plan.md");
    // Still exactly one file on disk and in the listing.
    expect(filesOnDisk(store, id)).toEqual(["plan.md"]);
  });

  it("refuses a missing task with TASK_NOT_FOUND", async () => {
    const store = freshDir("attach-missing-");
    const home = freshDir("attach-missing-home-");
    seedStore(store);
    const source = join(store, "plan.md");
    writeFileSync(source, "x");

    const r = await spawnCli(
      ["tasks", store, "--attach", source, "--task", "ghost", "--json"],
      { cwd: store, home },
    );
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stderr).error.code).toBe("TASK_NOT_FOUND");
  });

  it("refuses a directory with E_USAGE", async () => {
    const store = freshDir("attach-dir-");
    const home = freshDir("attach-dir-home-");
    seedStore(store);
    const id = await addTask(store, home);
    const sub = join(store, "docs");
    mkdirSync(sub);

    const r = await spawnCli(
      ["tasks", store, "--attach", sub, "--task", id, "--json"],
      { cwd: store, home },
    );
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr).error.code).toBe("E_USAGE");
  });

  it("requires --task", async () => {
    const store = freshDir("attach-notask-");
    const home = freshDir("attach-notask-home-");
    seedStore(store);
    const source = join(store, "plan.md");
    writeFileSync(source, "x");

    const r = await spawnCli(["tasks", store, "--attach", source, "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--attach needs --task");
  });

  it("--move deletes the source after a successful attach", async () => {
    const store = freshDir("attach-move-");
    const home = freshDir("attach-move-home-");
    seedStore(store);
    const id = await addTask(store, home);
    const source = join(store, "plan.md");
    writeFileSync(source, "# plan\n");

    const r = await spawnCli(
      ["tasks", store, "--attach", source, "--task", id, "--move"],
      { cwd: store, home },
    );
    expect(r.code).toBe(0);
    expect(existsSync(source)).toBe(false);
    expect(filesOnDisk(store, id)).toEqual(["plan.md"]);
  });

  it("refuses --attach combined with --edit", async () => {
    const store = freshDir("attach-combo-");
    const home = freshDir("attach-combo-home-");
    seedStore(store);
    const id = await addTask(store, home);
    const source = join(store, "plan.md");
    writeFileSync(source, "x");

    const r = await spawnCli(
      ["tasks", store, "--attach", source, "--task", id, "--edit", id],
      { cwd: store, home },
    );
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toContain("--attach cannot be combined");
  });
});
