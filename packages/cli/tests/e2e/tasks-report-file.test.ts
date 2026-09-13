/**
 * CLI e2e — `tasks --edit --report-file` must fail loudly when it cannot act.
 *
 * Reported symptom (task 6eea5009): passing `--report-file` on a task whose
 * type is not Research was silently ignored — the status still moved to
 * `review`, the local file stayed on disk, nothing was attached, and no
 * warning was printed. The flag was also silently ignored when used without
 * `--set-status review`.
 *
 * These tests spawn the real built CLI (`dist/index.js`) in temp stores and
 * assert on the exit code, the error output, and the persisted task + file
 * state on disk.
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

interface StoredTask {
  id: string;
  status?: string;
  type?: string;
}

/** Read the persisted task JSON straight from the temp store. */
function storedTask(store: string, taskId: string): StoredTask | undefined {
  const tasksDir = join(store, ".vibeflow", "tasks");
  for (const entry of readdirSync(tasksDir)) {
    const candidate = join(tasksDir, entry, `${taskId}.json`);
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf-8")) as StoredTask;
    }
  }
  return undefined;
}

/** Create a task through the real CLI and return its full id. */
async function addTask(
  store: string,
  home: string,
  type?: string,
): Promise<string> {
  const args = [
    "tasks",
    store,
    "--add",
    "--title",
    "Task under test",
    "--json",
  ];
  if (type) args.push("--type", type);
  const r = await spawnCli(args, { cwd: store, home });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout).task.id as string;
}

describe("tasks --edit --report-file", () => {
  it("errors and leaves the task untouched when the task is not Research", async () => {
    const store = freshDir("report-store-");
    const home = freshDir("report-home-");
    seedStore(store);
    const id = await addTask(store, home); // type is unset → not Research
    const report = join(store, "myreport.md");
    writeFileSync(report, "report content");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--report-file",
        report,
        "--comment",
        "test",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(2); // ExitCode.USAGE
    expect(r.stdout).toContain(
      "--report-file is only supported for Research tasks",
    );
    expect(r.stdout).toContain("this task has type: none");
    // Status must NOT have moved and the local file must NOT be deleted.
    expect(storedTask(store, id)?.status).toBe("todo");
    expect(existsSync(report)).toBe(true);
  });

  it("errors when --report-file is used without --set-status review", async () => {
    const store = freshDir("report-store-");
    const home = freshDir("report-home-");
    seedStore(store);
    const id = await addTask(store, home, "Research");
    const report = join(store, "myreport.md");
    writeFileSync(report, "report content");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "in-progress",
        "--report-file",
        report,
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(2); // ExitCode.USAGE
    expect(r.stdout).toContain("--report-file requires --set-status review");
    expect(storedTask(store, id)?.status).toBe("todo");
    expect(existsSync(report)).toBe(true);
  });

  it("errors when --report-file is passed with no status change at all", async () => {
    const store = freshDir("report-store-");
    const home = freshDir("report-home-");
    seedStore(store);
    const id = await addTask(store, home, "Research");
    const report = join(store, "myreport.md");
    writeFileSync(report, "report content");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--report-file", report],
      { cwd: store, home },
    );

    expect(r.code).toBe(2); // ExitCode.USAGE
    expect(r.stdout).toContain("--report-file requires --set-status review");
    expect(storedTask(store, id)?.status).toBe("todo");
    expect(existsSync(report)).toBe(true);
  });

  it("uploads the report and removes the local file for a Research task on review", async () => {
    const store = freshDir("report-store-");
    const home = freshDir("report-home-");
    seedStore(store);
    const id = await addTask(store, home, "Research");
    const report = join(store, "research-report.md");
    writeFileSync(report, "# Findings");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--report-file",
        report,
        "--comment",
        "report",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("✓ Report uploaded: research-report.md");
    expect(
      existsSync(
        join(store, ".vibeflow", "tasks", "files", id, "research-report.md"),
      ),
    ).toBe(true);
    expect(existsSync(report)).toBe(false);
    expect(storedTask(store, id)?.status).toBe("review");
  });
});
