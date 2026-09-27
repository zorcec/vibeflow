/**
 * CLI e2e — the `--json` machine-readability contract for `tasks`.
 *
 * Ruling: under `--json`, EVERY non-zero exit emits
 * `{ok:false, error:{code,message,retryable,suggestion?}}` on **stderr** with
 * **stdout left clean**. A refusal that prints chalk prose gives a machine
 * consumer empty stdout, no code, and nothing to branch on.
 *
 * Each test asserts the assigned CODE, not just the shape — an `ok:false`-only
 * assertion would pass whatever code was chosen.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { spawnCli, getFreePort } from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedGitUser(projectDir: string): void {
  execSync("git init && git config user.name 'E2E User' && git config user.email 'e2e@test.local'", {
    cwd: projectDir,
    stdio: "ignore",
  });
}

function writeSettings(projectDir: string, settings: Record<string, unknown>): void {
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(projectDir, ".vibeflow", "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf-8",
  );
}

function taskFile(store: string, taskId: string): string {
  const tasksDir = join(store, ".vibeflow", "tasks");
  for (const entry of readdirSync(tasksDir)) {
    const candidate = join(tasksDir, entry, `${taskId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  const flat = join(tasksDir, `${taskId}.json`);
  if (existsSync(flat)) return flat;
  throw new Error(`task file not found for ${taskId}`);
}

function readTask(store: string, taskId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(taskFile(store, taskId), "utf-8")) as Record<
    string,
    unknown
  >;
}

/** A home directory that makes the CLI take the online (SaaS) branch. */
function saasHome(): string {
  const home = freshDir("json-refusal-saas-home-");
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  writeFileSync(join(home, ".vibeflow", "token"), "test-token", "utf-8");
  return home;
}

type CliResult = { stdout: string; stderr: string; code: number | null };

/**
 * A refusal under `--json`: non-zero exit, EMPTY stdout, and one JSON envelope
 * on stderr carrying the assigned code.
 */
function expectRefusal(
  r: CliResult,
  code: string,
  opts: { retryable?: boolean } = {},
): { error: { code: string; message: string; retryable: boolean; suggestion?: string } } {
  expect(r.code).not.toBe(0);
  expect(r.stdout.trim()).toBe("");
  const envelope = JSON.parse(r.stderr) as {
    ok: boolean;
    error: { code: string; message: string; retryable: boolean; suggestion?: string };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe(code);
  expect(typeof envelope.error.message).toBe("string");
  expect(envelope.error.message.length).toBeGreaterThan(0);
  expect(typeof envelope.error.retryable).toBe("boolean");
  if (opts.retryable !== undefined)
    expect(envelope.error.retryable).toBe(opts.retryable);
  return envelope;
}

async function addTask(
  store: string,
  home: string,
  title: string,
  extra: string[] = [],
): Promise<string> {
  const r = await spawnCli(
    ["tasks", store, "--add", "--title", title, "--json", ...extra],
    { cwd: store, home },
  );
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as { task: { id: string } }).task.id;
}

/** A task claimed in-progress, so the board has a git-stamped author. */
async function claimedTask(store: string, home: string, title: string): Promise<string> {
  const id = await addTask(store, home, title);
  const claim = await spawnCli(
    ["tasks", store, "--edit", id, "--set-status", "in-progress", "--json"],
    { cwd: store, home },
  );
  expect(claim.code).toBe(0);
  return id;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks --json refusals carry a code on stderr", () => {
  it("E_USAGE — an unknown --type filter value", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(["tasks", store, "--type", "Nope", "--json"], {
      cwd: store,
      home,
    });
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe('Invalid type filter: "Nope"');
    expect(envelope.error.suggestion).toContain("Available types:");
  });

  it("E_USAGE — a --user filter that matches no author (lists the authors)", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    seedGitUser(store);
    await claimedTask(store, home, "Has an author");

    const r = await spawnCli(
      ["tasks", store, "--user", "ghost@nowhere.test", "--json"],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe('User not found: "ghost@nowhere.test"');
    expect(envelope.error.suggestion).toContain("Available users:");
  });

  it("E_USAGE — a --user filter where no author list can be built", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    await addTask(store, home, "Unattributed");

    // `--next` validates --user against an empty candidate list, so this is
    // the "no task authors are available on this board" refusal.
    const r = await spawnCli(
      ["tasks", store, "--next", "--user", "ghost@nowhere.test", "--json"],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe(
      "Cannot filter by user: no task authors are available on this board.",
    );
  });

  it("E_USAGE — an unknown --status filter value", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(["tasks", store, "--status", "nope", "--json"], {
      cwd: store,
      home,
    });
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe('Invalid status filter: "nope"');
    expect(envelope.error.suggestion).toContain("Valid statuses:");
  });

  it("E_USAGE — an unknown --set-status value", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Bad transition");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-status", "shipped", "--json"],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe('Invalid status: "shipped"');
    expect(envelope.error.suggestion).toContain("Valid statuses:");
  });

  it("E_USAGE — --report-file without --set-status review", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Researchish", ["--type", "Research"]);

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--report-file", "report.md", "--json"],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe(
      "--report-file requires --set-status review",
    );
  });

  it("E_USAGE — --report-file on a task that is not Research", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "A plain task");
    const report = join(store, "report.md");
    writeFileSync(report, "# report", "utf-8");

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
        "--json",
      ],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toContain(
      "--report-file is only supported for Research tasks",
    );
  });

  it("E_NOT_FOUND — --report-file pointing at a file that does not exist", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Research task", ["--type", "Research"]);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--report-file",
        join(store, "missing.md"),
        "--json",
      ],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_NOT_FOUND");
    expect(envelope.error.message).toContain("Report file not found:");
    expect(envelope.error.message).toContain("missing.md");
  });

  it("E_USAGE — --report-file that is not Markdown", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Research task", ["--type", "Research"]);
    const report = join(store, "notes.txt");
    writeFileSync(report, "not markdown", "utf-8");

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
        "--json",
      ],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe(
      "Report file must be a Markdown (.md) file",
    );
  });

  it("TASK_NOT_FOUND — --get on an id that is not on the board", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(["tasks", store, "--get", "zzzzzzzz", "--json"], {
      cwd: store,
      home,
    });
    const envelope = expectRefusal(r, "TASK_NOT_FOUND");
    expect(envelope.error.message).toBe("Task not found: zzzzzzzz");
  });

  it("TASK_NOT_FOUND — --edit on an id that is not on the board", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(
      ["tasks", store, "--edit", "zzzzzzzz", "--set-status", "in-progress", "--json"],
      { cwd: store, home },
    );
    expectRefusal(r, "TASK_NOT_FOUND");
  });

  it("TASK_NOT_FOUND — --commit on a task that does not exist", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(
      ["tasks", store, "--commit", "--task", "zzzzzzzz", "--message", "x", "--json"],
      { cwd: store, home },
    );
    expectRefusal(r, "TASK_NOT_FOUND");
  });

  it("TASK_NOT_FOUND — --add with a dangling --parent", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(
      [
        "tasks",
        store,
        "--add",
        "--title",
        "Orphan",
        "--parent",
        "deadbeef",
        "--json",
      ],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "TASK_NOT_FOUND");
    expect(envelope.error.message).toContain("Parent task not found");
  });

  it("TASK_NOT_FOUND — --set-parent pointing at a task that does not exist", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Needs a parent");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-parent", "deadbeefdeadbeef", "--json"],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "TASK_NOT_FOUND");
    expect(envelope.error.message).toContain("Parent task not found");
  });

  it("E_USAGE — --set-parent that would create a cycle (E_USAGE, not a lookup miss)", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const parent = await addTask(store, home, "Parent");
    const child = await addTask(store, home, "Child", ["--parent", parent]);

    // The child is already a descendant of the parent, so making the parent a
    // child of the child is a cycle — the producer's code, passed through.
    const r = await spawnCli(
      ["tasks", store, "--edit", parent, "--set-parent", child, "--json"],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toContain("Cycle detected");
  });

  it("E_USAGE — --commit when git cannot run (nothing was written)", async () => {
    // No `git init`: commitTaskPaths fails, so this is a refusal, not a
    // partial success — the task file must be untouched.
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Uncommittable");
    const before = readFileSync(taskFile(store, id), "utf-8");

    const r = await spawnCli(
      ["tasks", store, "--commit", "--task", id, "--message", "nope", "--json"],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(typeof envelope.error.message).toBe("string");
    expect(readFileSync(taskFile(store, id), "utf-8")).toBe(before);
  });

  it("E_USAGE — `verify --json` without a task id", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(["verify", "--json"], { cwd: store, home });
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe("Task ID required.");
  });
});

describe("tasks --json online (SaaS) refusals carry a code", () => {
  /** A port nothing listens on → the client sees NETWORK_ERROR. */
  async function deadApiUrl(): Promise<string> {
    const port = await getFreePort();
    return `http://127.0.0.1:${port}`;
  }

  it("E_BACKEND_UNAVAILABLE (retryable) — listing with an unreachable host", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const r = await spawnCli(["tasks", store, "--json"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: await deadApiUrl() },
    });
    const envelope = expectRefusal(r, "E_BACKEND_UNAVAILABLE", {
      retryable: true,
    });
    expect(envelope.error.message).toBe("Unable to reach the online backend.");
  });

  it("E_BACKEND_UNAVAILABLE (not retryable) — a host that answers 500", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const server: Server = createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as { port: number };

    const r = await spawnCli(["tasks", store, "--json"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: `http://127.0.0.1:${port}` },
    });
    expectRefusal(r, "E_BACKEND_UNAVAILABLE", { retryable: false });
  });

  it("E_BACKEND_UNAVAILABLE — --get against an unreachable host", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const r = await spawnCli(["tasks", store, "--get", "abcd1234", "--json"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: await deadApiUrl() },
    });
    expectRefusal(r, "E_BACKEND_UNAVAILABLE", { retryable: true });
  });

  it("E_BACKEND_UNAVAILABLE — --next against an unreachable host", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const r = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: await deadApiUrl() },
    });
    expectRefusal(r, "E_BACKEND_UNAVAILABLE", { retryable: true });
  });

  it("E_BACKEND_UNAVAILABLE — --add against an unreachable host", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Online task", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: await deadApiUrl() } },
    );
    const envelope = expectRefusal(r, "E_BACKEND_UNAVAILABLE", {
      retryable: true,
    });
    expect(envelope.error.message).toBe(
      "Failed to create task in online board.",
    );
  });

  it("E_BACKEND_UNAVAILABLE — --edit against an unreachable host", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Local copy");
    const online = saasHome();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "in-progress",
        "--json",
      ],
      { cwd: store, home: online, env: { VIBEFLOW_API_URL: await deadApiUrl() } },
    );
    const envelope = expectRefusal(r, "E_BACKEND_UNAVAILABLE", {
      retryable: true,
    });
    expect(envelope.error.message).toBe(`Failed to update task: ${id}`);
  });

  it("E_USAGE — --add --parent is refused on the online board", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const r = await spawnCli(
      [
        "tasks",
        store,
        "--add",
        "--title",
        "Child",
        "--parent",
        "abcd1234",
        "--json",
      ],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe(
      "--parent is only supported for local tasks",
    );
  });

  it("E_USAGE — --set-parent is refused on the online board", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const localHome = freshDir("json-refusal-home-");
    const id = await addTask(store, localHome, "Local copy");
    const online = saasHome();

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-parent", "abcd1234", "--json"],
      { cwd: store, home: online },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toBe(
      "--set-parent / --no-parent is only supported for local tasks",
    );
  });
});
