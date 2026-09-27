/**
 * CLI e2e — the `--json` machine-readability contract for `tasks`.
 *
 * Ruling: under `--json`, EVERY non-zero exit emits
 * `{ok:false, error:{code,message,retryable,suggestion?}}` on **stderr** with
 * **stdout left clean**. A refusal that prints chalk prose gives a machine
 * consumer empty stdout, no code, and nothing to branch on.
 *
 * Each test asserts the assigned CODE, not just the shape — an `ok:false`-only
 * assertion would pass whatever code was chosen. The two partial-success paths
 * (the task data was saved, a follow-on step did not complete) are the mirror
 * image: exit 0, `ok:true`, and a `warning` on the success payload.
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

/**
 * Hand-writes a raw task file, bypassing the CLI.
 *
 * The two shape flags are what `writeSortKeyMinimal` branches on, and they are
 * the difference between a reindex that writes and one that plans but does
 * not: the writer inserts `sortKey` above the `\n  "updated":` anchor, so a
 * PRETTY-printed task carrying `updated` is keyable and a single-line task
 * without it is not (the function returns false, writes nothing).
 */
function writeRawTask(
  store: string,
  taskId: string,
  shape: { pretty: boolean; updated: boolean },
): void {
  const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  const task: Record<string, unknown> = {
    id: taskId,
    title: `Hand-written ${taskId}`,
    description: "",
    status: "todo",
    priority: "Medium",
    type: "Task",
    created: "2026-01-01T00:00:00.000Z",
    tags: [],
    comments: [],
    files: [],
    ...(shape.updated ? { updated: "2026-01-01T00:00:00.000Z" } : {}),
  };
  writeFileSync(
    join(dir, `${taskId}.json`),
    shape.pretty ? JSON.stringify(task, null, 2) : JSON.stringify(task),
    "utf-8",
  );
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

  it("GIT_COMMIT_FAILED — --commit when git cannot run (nothing was written)", async () => {
    // No `git init`: commitTaskPaths fails, so this is a refusal, not a
    // partial success — the task file must be untouched. The code is the SAME
    // one the post-review auto-commit notice uses; here it means "nothing was
    // committed", so `E_USAGE` keeps its single meaning and the code↔exit-code
    // pairing stays intact.
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Uncommittable");
    const before = readFileSync(taskFile(store, id), "utf-8");

    const r = await spawnCli(
      ["tasks", store, "--commit", "--task", id, "--message", "nope", "--json"],
      { cwd: store, home },
    );
    const envelope = expectRefusal(r, "GIT_COMMIT_FAILED", {
      retryable: false,
    });
    // commitTaskPaths REPORTS this failure ({ok:false}) rather than throwing
    // when git cannot run at all, so the message is git's own; the staging
    // hint is what both git-failure branches guarantee.
    expect(envelope.error.suggestion).toContain("git add");
    expect(readFileSync(taskFile(store, id), "utf-8")).toBe(before);
  });

  it("E_USAGE — `--edit --json` with no task id and nothing to edit", async () => {
    // The usage-help block is chalk prose. Under --json it used to print 700+
    // bytes of it to stdout and exit 0, so a consumer could not even
    // JSON.parse what it got. An impossible flag combination is E_USAGE, which
    // is what the documented rule already prescribes.
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(["tasks", store, "--edit", "--json"], {
      cwd: store,
      home,
    });
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toContain("--edit needs a task id");
  });

  it("E_USAGE — `--edit <id> --json` with no edit flag at all", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const id = await addTask(store, home, "Nothing to change");
    const r = await spawnCli(["tasks", store, "--edit", id, "--json"], {
      cwd: store,
      home,
    });
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toContain("nothing to edit");
  });

  it("the usage help block itself is unchanged in human mode", async () => {
    const store = freshDir("json-refusal-store-");
    const home = freshDir("json-refusal-home-");
    const r = await spawnCli(["tasks", store, "--edit"], { cwd: store, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("vibeflow tasks --edit — LLM Usage Instructions");
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

  /** A host that answers every request with one status code. */
  async function statusUrl(status: number): Promise<string> {
    const server: Server = createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `status ${status}` }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
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

  it("E_NOT_AUTHENTICATED (not retryable) — a host that answers 401", async () => {
    // SaaS mode is selected BECAUSE a token file exists, so the client's
    // literal NOT_AUTHENTICATED (no token at all) is the rare case. What
    // really happens is an expired or revoked token rejected with 401/403 —
    // which used to be labelled E_BACKEND_UNAVAILABLE, i.e. "the backend is
    // down, maybe retry", for a session retrying cannot fix.
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const r = await spawnCli(["tasks", store, "--json"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: await statusUrl(401) },
    });
    const envelope = expectRefusal(r, "E_NOT_AUTHENTICATED", {
      retryable: false,
    });
    expect(envelope.error.suggestion).toContain("vibeflow login");
  });

  it("E_NOT_AUTHENTICATED (not retryable) — a host that answers 403", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const r = await spawnCli(["tasks", store, "--json"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: await statusUrl(403) },
    });
    const envelope = expectRefusal(r, "E_NOT_AUTHENTICATED", {
      retryable: false,
    });
    expect(envelope.error.suggestion).toContain("vibeflow login");
  });

  it("E_NOT_AUTHENTICATED — --edit against a host that answers 401", async () => {
    const store = freshDir("json-refusal-saas-store-");
    const home = saasHome();
    const r = await spawnCli(
      ["tasks", store, "--edit", "abcd1234", "--set-status", "in-progress", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: await statusUrl(401) } },
    );
    expectRefusal(r, "E_NOT_AUTHENTICATED", { retryable: false });
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

describe("tasks --json partial success is a warning, not a refusal", () => {
  it("GIT_COMMIT_FAILED — review saved, auto-commit did not: exit 0 + warning", async () => {
    const store = freshDir("json-partial-store-");
    const home = freshDir("json-partial-home-");
    seedGitUser(store);
    writeSettings(store, { autoCommit: true });
    const id = await addTask(store, home, "Auto-commit target");

    // Nothing is staged, so the commit cannot happen — but the task file was
    // already written, so this must NOT be ok:false and must NOT exit non-zero.
    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--comment",
        "did the work",
        "--commit-message",
        "feat: work",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { status: string };
      warning?: { code: string; message: string };
      warnings?: unknown;
    };
    expect(payload.ok).toBe(true);
    expect(payload.warning?.code).toBe("GIT_COMMIT_FAILED");
    expect(payload.warning?.message).toContain("did NOT happen");
    expect(payload.warnings).toBeUndefined();
    expect(r.stderr).not.toContain('"ok":false');
    // The task data really is on disk.
    expect(readTask(store, id).status).toBe("review");
  });

  it("GIT_COMMIT_FAILED — human mode keeps the warning line and exits 0", async () => {
    const store = freshDir("json-partial-store-");
    const home = freshDir("json-partial-home-");
    seedGitUser(store);
    writeSettings(store, { autoCommit: true });
    const id = await addTask(store, home, "Auto-commit target");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--comment",
        "did the work",
        "--commit-message",
        "feat: work",
      ],
      { cwd: store, home },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Task WAS updated");
    expect(r.stdout).toContain("the commit did NOT happen");
  });

  it("REINDEX_INCOMPLETE — keys written, post-assert failed: exit 0 + notice", async () => {
    const store = freshDir("json-partial-store-");
    const home = freshDir("json-partial-home-");
    // One keyless task the minimal writer CAN key (pretty-printed, so the
    // `"\n  \"updated\":"` anchor exists) … and one it CANNOT (single-line, no
    // `updated` field at all — see writeSortKeyMinimal). The first write lands,
    // so the run is partial success and the post-assert is what fails.
    writeRawTask(store, "fixable000000", { pretty: true, updated: true });
    writeRawTask(store, "orphan00000000", { pretty: false, updated: false });

    const r = await spawnCli(["tasks", store, "--reindex-sort-keys", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      written: number;
      reindexVerified: boolean;
      warning?: { code: string; message: string };
    };
    expect(payload.ok).toBe(true);
    // The keys DID land — that is the whole basis for exit 0 here.
    expect(payload.written).toBe(1);
    expect(payload.reindexVerified).toBe(false);
    expect(payload.warning?.code).toBe("REINDEX_INCOMPLETE");
    expect(payload.warning?.message).toContain("Reindex incomplete");
  });

  it("REINDEX_WRITE_FAILED — keys planned, none written: ok:false + non-zero exit", async () => {
    // writeSortKeyMinimal can compute a patch and then decline to write it, so
    // a run that PLANNED writes and wrote NONE never touched the store.
    // Reporting that as ok:true told a consumer the re-keying landed when
    // nothing did — so it is a refusal, and this fixture is the real path, not
    // a theoretical one: every task here is unwritable.
    const store = freshDir("json-partial-store-");
    const home = freshDir("json-partial-home-");
    writeRawTask(store, "orphan00000000", { pretty: false, updated: false });
    const before = readFileSync(taskFile(store, "orphan00000000"), "utf-8");

    const r = await spawnCli(["tasks", store, "--reindex-sort-keys", "--json"], {
      cwd: store,
      home,
    });
    const envelope = expectRefusal(r, "REINDEX_WRITE_FAILED", {
      retryable: false,
    });
    expect(envelope.error.message).toContain("wrote 0 of");
    expect(envelope.error.suggestion).toContain("orphan00000000");
    // Nothing landed — and no manifest claiming an apply that never happened.
    expect(readFileSync(taskFile(store, "orphan00000000"), "utf-8")).toBe(before);
    expect(existsSync(join(store, ".vibeflow", "reindex-sort-keys-manifest.json"))).toBe(
      false,
    );
  });

  it("REINDEX_WRITE_FAILED — human mode says so plainly and exits non-zero", async () => {
    const store = freshDir("json-partial-store-");
    const home = freshDir("json-partial-home-");
    writeRawTask(store, "orphan00000000", { pretty: false, updated: false });

    const r = await spawnCli(["tasks", store, "--reindex-sort-keys"], {
      cwd: store,
      home,
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("wrote 0 of");
  });

  it("a clean success carries no warning/warnings key at all", async () => {
    const store = freshDir("json-partial-store-");
    const home = freshDir("json-partial-home-");
    const id = await addTask(store, home, "Clean edit");

    const edit = await spawnCli(
      ["tasks", store, "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: store, home },
    );
    expect(edit.code).toBe(0);
    const editPayload = JSON.parse(edit.stdout) as Record<string, unknown>;
    expect(editPayload.ok).toBe(true);
    expect("warning" in editPayload).toBe(false);
    expect("warnings" in editPayload).toBe(false);

    // …and a verified reindex is a clean success too.
    const reindex = await spawnCli(
      ["tasks", store, "--reindex-sort-keys", "--json"],
      { cwd: store, home },
    );
    expect(reindex.code).toBe(0);
    const reindexPayload = JSON.parse(reindex.stdout) as Record<string, unknown>;
    expect(reindexPayload.reindexVerified).toBe(true);
    expect("warning" in reindexPayload).toBe(false);
    expect("warnings" in reindexPayload).toBe(false);
  });
});

/**
 * The stdout-purity sweep.
 *
 * Every other test in this file asks "does this path carry the RIGHT code?".
 * This one asks the weaker, broader question that all of them depend on: does
 * anything reach stdout that a `JSON.parse` cannot read? It exists because the
 * refusal guard (`tests/unit/json-refusal-guard.test.ts`) is keyed on NON-ZERO
 * exits, so it structurally cannot see prose on stdout under `--json` with
 * exit 0 — the class that hid the `--edit` usage-help block and the trailing
 * auto-push lines from the review that added that guard.
 *
 * The rule, applied uniformly: under `--json`, stdout is either empty or
 * exactly one JSON document. Nothing in between. Anything less specific would
 * let the next chalk line back in.
 *
 * There is exactly ONE deliberate exception, listed with its provenance in
 * `KNOWN_EXCEPTIONS` below. It is an owner decision recorded in three test
 * files, not an oversight — an exception without provenance is just a hole
 * with a nice comment, so the provenance is part of the entry.
 */
describe("tasks --json stdout is empty or one JSON document — always", () => {
  /**
   * Rows the owner has ruled OUT of the rule, with the decision that put them
   * there. Each one still runs on every sweep; it is checked against its
   * recorded behaviour instead, so revoking the ruling fails this test loudly
   * rather than silently.
   */
  const KNOWN_EXCEPTIONS: Array<{
    label: string;
    why: string;
    decidedIn: string[];
    expect: (r: CliResult) => string | null;
  }> = [
    {
      label: "next with nothing to claim",
      // DELIBERATE. An empty board is not a failure — there is simply nothing
      // to hand out — so `--next --json` prints a sentence and exits 0. The
      // ruling is recorded in these three tests, one of which says outright
      // "guard consumers accordingly". The CLI/MCP divergence here (MCP answers
      // the identical situation with NO_TASKS_AVAILABLE, ok:false) is filed as
      // its own ticket for an owner decision; it is deliberately NOT resolved
      // here, because revoking a recorded ruling must not ride along with a
      // stdout-purity change.
      why: "empty board is not a failure; the sentence and exit 0 are pinned",
      decidedIn: [
        "tests/e2e/mcp-hang.test.ts:53-66 (test 2)",
        "tests/e2e/mcp-claim-race.test.ts:11-12 (docstring)",
        "tests/e2e/mcp-claim-race.test.ts:137-148 (test 3)",
      ],
      expect: (r) => {
        if (r.code !== 0)
          return `expected exit 0 on an empty board, got ${r.code}`;
        if (!r.stdout.includes("No todo tasks found"))
          return `expected the pinned sentence, got:\n${r.stdout.slice(0, 200)}`;
        return null;
      },
    },
  ];

  /** Every row is asserted the same way, so a new row cannot be weaker. */
  function stdoutProblem(r: CliResult, label: string): string | null {
    const trimmed = r.stdout.trim();
    if (trimmed === "") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return `${label}: stdout is neither empty nor JSON (${(err as Error).message}) — got:\n${trimmed.slice(0, 400)}`;
    }
    // A JSONL stream would also parse as a failure, so name the one-document
    // rule explicitly: exactly one object, carrying the ok discriminant.
    if (typeof parsed !== "object" || parsed === null) {
      return `${label}: stdout is JSON but not an object — got:\n${trimmed.slice(0, 400)}`;
    }
    if (!("ok" in (parsed as Record<string, unknown>))) {
      return `${label}: stdout is JSON but carries no "ok" discriminant — got:\n${trimmed.slice(0, 400)}`;
    }
    return null;
  }

  it("a table of success and refusal paths keeps stdout parseable", async () => {
    const store = freshDir("json-purity-store-");
    const home = freshDir("json-purity-home-");
    seedGitUser(store);
    writeSettings(store, { autoCommit: true, autoPush: true });
    const id = await addTask(store, home, "Purity target");
    const researchId = await addTask(store, home, "Research target", [
      "--type",
      "Research",
    ]);
    // Already in-progress, so the conflict notice has something to fire on.
    await spawnCli(
      ["tasks", store, "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: store, home },
    );
    writeRawTask(store, "orphan00000000", { pretty: false, updated: false });

    const table: Array<{ label: string; args: string[] }> = [
      { label: "bare list", args: ["--json"] },
      { label: "list filtered", args: ["--status", "todo", "--json"] },
      { label: "bogus status filter", args: ["--status", "nope", "--json"] },
      { label: "successful get", args: ["--get", id, "--json"] },
      { label: "get a missing task", args: ["--get", "nosuchid", "--json"] },
      { label: "edit with nothing to edit", args: ["--edit", "--json"] },
      { label: "set-status done", args: ["--edit", id, "--set-status", "done", "--json"] },
      {
        label: "research task claimed",
        args: ["--edit", researchId, "--set-status", "in-progress", "--json"],
      },
      {
        label: "already in-progress",
        args: ["--edit", id, "--set-status", "in-progress", "--json"],
      },
      {
        label: "cannot verdict",
        args: [
          "--edit",
          id,
          "--set-verify",
          "cannot",
          "--verify-reason",
          "no badge here",
          "--json",
        ],
      },
      { label: "next", args: ["--next", "--json"] },
      { label: "reindex (refusal)", args: ["--reindex-sort-keys", "--json"] },
      {
        label: "commit with auto-push on",
        args: ["--commit", "--task", id, "--message", "chore: purity", "--json"],
      },
      {
        label: "commit on a missing task",
        args: ["--commit", "--task", "nosuchid", "--message", "x", "--json"],
      },
      { label: "report-file on a non-Research task", args: ["--edit", id, "--report-file", "r.md", "--json"] },
    ];

    // Collect EVERY offender rather than throwing on the first, so one run
    // reports the whole class instead of one site per run.
    const offenders: string[] = [];
    const cases: Array<{ label: string; args: string[] }> = [
      ...table,
      // The empty board is the pinned exception: it must be checked LAST so it
      // cannot mask a regression in any ordinary row.
      {
        label: KNOWN_EXCEPTIONS[0].label,
        args: ["--next", "--json"],
      },
    ];
    for (const c of cases) {
      const r = await spawnCli(["tasks", store, ...c.args], { cwd: store, home });
      const exception = KNOWN_EXCEPTIONS.find((e) => e.label === c.label);
      const problem = exception
        ? exception.expect(r)
        : stdoutProblem(r, c.label);
      if (problem) offenders.push(problem);
    }
    expect(offenders).toEqual([]);

    // A stale exception is a bug for the same reason a stale allowlist entry
    // is: it excuses a rule that now holds, and hides the next site that lands
    // there. Provenance is part of the entry, so check it is still there.
    for (const e of KNOWN_EXCEPTIONS) {
      expect(
        e.decidedIn.length,
        `${e.label}: an exception without provenance is just a hole with a nice comment`,
      ).toBeGreaterThan(0);
    }
  }, 120_000);
});
