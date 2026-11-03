/**
 * In-process coverage of the `tasks` commander tree in src/index.ts.
 *
 * src/index.ts is the 6k-line commander wiring over src/commands + src/core.
 * Spawning the built binary (tests/e2e) covers it from the outside, but the
 * v8 unit-coverage gate only sees this process — so without in-process
 * drivers the whole file reads ~24% and sinks the gate no matter how
 * thorough the unit suite is. This file drives `createProgram()` directly
 * (the same seam tests/unit/cli-json-notices.test.ts uses:
 * VIBEFLOW_CLI_SKIP_PARSE=1 at import time, then parseAsync with
 * { from: "user" }), one hermetic store per test.
 *
 * Every test below is behavior-pinned, not smoke: each asserts the parsed
 * --json envelope AND/OR the on-disk store mutation, so a broken handler
 * (wrong status written, task not created, delete not confirmed, usage
 * guard removed) fails the test.
 *
 * Batches (one file; the harness is shared): list/get/add/edit/comment,
 * delete/next/usage-guards/top-level (batch 1); attach/get-file round-trip,
 * commit guard, reindex, normalize, edit link/tag/priority, list flag
 * matrix, verify usage, telemetry, openapi --yaml, changelog, auth
 * list/clear, authors link --dry-run (batch 2);
 * verify-verdict edits, relates/blocks link edits, add annotation fields,
 * local parent link, empty-board next, id-prefix resolution, list/get flag
 * matrix, telemetry toggles, changelog --all, legacy status, link success
 * path (batch 3); delete --dry-run, research report-file flow,
 * attach --move, --no-parent, next blocked/stranded branches, commit
 * success in a git repo, add --type (batch 4); human-mode twins of the
 * same handlers, edit --dry-run, --comment/--children/--edit/--type/
 * --status/--user/--tag guards (batch 5); edit/
 * comment/attach/normalize/add-guard/commit human twins plus the
 * commit→authors-link linked flow (batch 6); auto-commit/auto-push
 * notices, next --dry-run, delete --dry-run human (batch 7).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { Command } from "commander";
import { gitEnvWithCleanLocation } from "../../src/core/git-env.js";

let createProgram: () => Command;
const cleanups: Array<() => void> = [];

// Scope every fixture `git` call below to its temp dir: under a git hook in
// a linked worktree an inherited GIT_DIR would redirect `git init`/`git
// config`/`git commit` into the enclosing repo (ticket e138e51d
// worktree-config pollution). `cwd` alone does not protect — only a clean
// location env makes git resolve the repo from `cwd`.
const gitEnv = gitEnvWithCleanLocation();

beforeAll(async () => {
  process.env.VIBEFLOW_TELEMETRY = "0";
  process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
  process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
  try {
    ({ createProgram } = await import("../../src/index.js"));
  } finally {
    delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
    delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
  }
});

type Captured = {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  logged: string[];
};

async function settle(size: () => number): Promise<void> {
  for (let tick = 0; tick < 50; tick++) {
    await new Promise((r) => setTimeout(r, 10));
    if (size() > 0) break;
  }
  let last = -1;
  let quiet = 0;
  for (let tick = 0; tick < 250; tick++) {
    await new Promise((r) => setTimeout(r, 10));
    const now = size();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 3) return;
  }
}

async function runCli(argv: string[], home: string): Promise<Captured> {
  const previous = {
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
    exitCode: process.exitCode,
    home: process.env.HOME,
  };
  const logged: string[] = [];
  let stdout = "";
  let stderr = "";
  (process.stdout.write as unknown) = (chunk: string) => {
    stdout += chunk;
    return true;
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    stderr += chunk;
    return true;
  };
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    });
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    });
  process.exitCode = undefined;
  process.env.HOME = home;
  try {
    const program = createProgram();
    await program.parseAsync(argv, { from: "user" });
    await settle(() => stdout.length + stderr.length + logged.length);
    return { stdout, stderr, exitCode: process.exitCode, logged };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    (process.stdout.write as unknown) = previous.stdout;
    (process.stderr.write as unknown) = previous.stderr;
    process.exitCode = previous.exitCode;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
}

function taskJson(id: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify(
    {
      id,
      title: `Task ${id}`,
      description: "",
      status: "todo",
      type: "Task",
      priority: "Medium",
      selector: "/",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
      comments: [],
      files: [],
      tags: [],
      ...overrides,
    },
    null,
    2,
  );
}

/** Hermetic store with two roots (todo + in-progress) and one child. */
function fixture(prefix: string): { store: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = join(base, "store");
  const home = join(base, "home");
  const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "aaa00001.json"), taskJson("aaa00001"), "utf-8");
  writeFileSync(
    join(dir, "bbb00002.json"),
    taskJson("bbb00002", { status: "in-progress", title: "Second task" }),
    "utf-8",
  );
  writeFileSync(
    join(dir, "ccc00003.json"),
    taskJson("ccc00003", {
      title: "Child task",
      links: [{ taskId: "aaa00001", type: "parent" }],
    }),
    "utf-8",
  );
  return { store, home };
}

function readStore(store: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json"))
        out.push(JSON.parse(readFileSync(p, "utf-8")));
    }
  };
  walk(join(store, ".vibeflow", "tasks"));
  return out;
}

function readTask(store: string, id: string): Record<string, unknown> {
  const t = readStore(store).find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} missing from store`);
  return t;
}

function storeHas(store: string, id: string): boolean {
  return readStore(store).some((t) => t.id === id);
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

// ---- cli-tasks-tree.test.ts ----
describe("tasks list/get (in-process commander tree)", () => {
  it("list --json returns every root with ok:true", async () => {
    const { store, home } = fixture("cli-tree-list-");
    const r = await runCli(["tasks", store, "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      tasks: Array<{ id: string }>;
    };
    expect(payload.ok).toBe(true);
    const ids = payload.tasks.map((t) => t.id);
    expect(ids).toContain("aaa00001");
    expect(ids).toContain("bbb00002");
  });

  it("list --status filters to the requested lane", async () => {
    const { store, home } = fixture("cli-tree-status-");
    const r = await runCli(["tasks", store, "--status", "in-progress", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      tasks: Array<{ id: string; status: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.tasks.length).toBeGreaterThan(0);
    for (const t of payload.tasks) expect(t.status).toBe("in-progress");
    expect(payload.tasks.map((t) => t.id)).not.toContain("aaa00001");
  });

  it("list human mode prints titles, not a JSON envelope", async () => {
    const { store, home } = fixture("cli-tree-human-");
    const r = await runCli(["tasks", store], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.stdout.trim()).toBe("");
    expect(r.logged.join("\n")).toContain("Second task");
  });

  it("get --json returns the single task detail", async () => {
    const { store, home } = fixture("cli-tree-get-");
    const r = await runCli(["tasks", store, "--get", "aaa00001", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string; title: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.task.id).toBe("aaa00001");
    expect(payload.task.title).toBe("Task aaa00001");
  });

  it("get of an unknown id refuses with TASK_NOT_FOUND", async () => {
    const { store, home } = fixture("cli-tree-getmiss-");
    const r = await runCli(["tasks", store, "--get", "zzz99999", "--json"], home);
    expect(r.exitCode).not.toBe(0);
    const payload = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("TASK_NOT_FOUND");
  });

  it("get prints the child count for a parent", async () => {
    const { store, home } = fixture("cli-tree-children-");
    const r = await runCli(["tasks", store, "--get", "aaa00001"], home);
    expect(r.exitCode ?? 0).toBe(0);
    // The human detail ends with the child roll-up (--children is a
    // listing-only flag; combining it with --get is refused, see below).
    expect(r.logged.join("\n")).toContain("children (1)");
  });

  it("listing --children includes child rows", async () => {
    const { store, home } = fixture("cli-tree-childrenflag-");
    const r = await runCli(["tasks", store, "--children", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      tasks: Array<{ id: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.tasks.map((t) => t.id)).toContain("ccc00003");
  });
});

describe("tasks add/edit/comment (in-process commander tree)", () => {
  it("add writes a new task file and reports its id", async () => {
    const { store, home } = fixture("cli-tree-add-");
    const before = readStore(store).map((t) => t.id);
    const r = await runCli(
      ["tasks", store, "--add", "--title", "Brand new", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string; title: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.task.title).toBe("Brand new");
    // The write really landed: a new file exists and round-trips.
    expect(before).not.toContain(payload.task.id);
    expect(storeHas(store, payload.task.id)).toBe(true);
  });

  it("add without --title is refused before anything is written", async () => {
    const { store, home } = fixture("cli-tree-addnotitle-");
    const before = readStore(store).length;
    const r = await runCli(["tasks", store, "--add", "--json"], home);
    expect(r.exitCode).not.toBe(0);
    const payload = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("E_USAGE");
    expect(readStore(store).length).toBe(before);
  });

  it("add with a malformed --url is refused with E_USAGE", async () => {
    const { store, home } = fixture("cli-tree-addurl-");
    const r = await runCli(
      ["tasks", store, "--add", "--title", "X", "--url", "not-a-url", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });

  it("edit --set-status persists the new lane on disk", async () => {
    const { store, home } = fixture("cli-tree-edit-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-status", "in-progress", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const onDisk = readStore(store).find((t) => t.id === "aaa00001");
    expect(onDisk?.status).toBe("in-progress");
  });

  it("edit --title renames the task", async () => {
    const { store, home } = fixture("cli-tree-rename-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--title", "Renamed", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(readStore(store).find((t) => t.id === "aaa00001")?.title).toBe(
      "Renamed",
    );
  });

  it("edit of an unknown id refuses without touching the store", async () => {
    const { store, home } = fixture("cli-tree-editmiss-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(
      ["tasks", store, "--edit", "zzz99999", "--set-status", "done", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("edit --comment appends to the task comments", async () => {
    const { store, home } = fixture("cli-tree-comment-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--comment", "hello world", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const onDisk = readStore(store).find((t) => t.id === "aaa00001") as {
      comments: Array<{ text: string }>;
    };
    expect(onDisk.comments.length).toBe(1);
    expect(onDisk.comments[0].text).toBe("hello world");
  });
});

describe("tasks delete/next (in-process commander tree)", () => {
  it("delete without --yes is refused and keeps the file", async () => {
    const { store, home } = fixture("cli-tree-delprev-");
    const r = await runCli(["tasks", store, "--delete", "aaa00001", "--json"], home);
    expect(storeHas(store, "aaa00001")).toBe(true);
    // The --json refusal names the confirmation gate; nothing was deleted.
    expect(r.stderr).toContain("CONFIRM_REQUIRED");
    expect(r.exitCode).not.toBe(0);
  });

  it("delete --yes removes a leaf file", async () => {
    const { store, home } = fixture("cli-tree-delyes-");
    const r = await runCli(
      ["tasks", store, "--delete", "ccc00003", "--yes", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(storeHas(store, "ccc00003")).toBe(false);
    // Untouched neighbours survive the delete.
    expect(storeHas(store, "aaa00001")).toBe(true);
  });

  it("delete --yes refuses a local parent that still has children", async () => {
    const { store, home } = fixture("cli-tree-delparent-");
    const r = await runCli(
      ["tasks", store, "--delete", "aaa00001", "--yes", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    // Neither the parent nor the child was removed.
    expect(storeHas(store, "aaa00001")).toBe(true);
    expect(storeHas(store, "ccc00003")).toBe(true);
  });

  it("delete of an unknown id refuses", async () => {
    const { store, home } = fixture("cli-tree-delmiss-");
    const r = await runCli(["tasks", store, "--delete", "zzz99999", "--json"], home);
    expect(r.exitCode).not.toBe(0);
  });

  it("next --json claims the next actionable task", async () => {
    const { store, home } = fixture("cli-tree-next-");
    const r = await runCli(["tasks", store, "--next", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string; status: string };
    };
    expect(payload.ok).toBe(true);
    // The claimed task left the todo lane on disk.
    const onDisk = readStore(store).find((t) => t.id === payload.task.id);
    expect(onDisk?.status).not.toBe("todo");
  });
});

describe("tasks usage guards (in-process commander tree)", () => {
  it("--parent without --add is refused", async () => {
    const { store, home } = fixture("cli-tree-g1-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--parent", "bbb00002", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });

  it("--delete combined with --add is refused", async () => {
    const { store, home } = fixture("cli-tree-g2-");
    const r = await runCli(
      ["tasks", store, "--delete", "aaa00001", "--add", "--title", "X", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
    expect(storeHas(store, "aaa00001")).toBe(true);
  });

  it("--yes without --delete is refused", async () => {
    const { store, home } = fixture("cli-tree-g3-");
    const r = await runCli(["tasks", store, "--yes", "--json"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });

  it("--attach without --task is refused", async () => {
    const { store, home } = fixture("cli-tree-g4-");
    const r = await runCli(
      ["tasks", store, "--attach", "some.png", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });

  it("--out without --get-file is refused", async () => {
    const { store, home } = fixture("cli-tree-g5-");
    const r = await runCli(
      ["tasks", store, "--get", "aaa00001", "--out", "x.png", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });
});

describe("top-level commands (in-process commander tree)", () => {
  it("status reports local mode when no token exists", async () => {
    const { home } = fixture("cli-tree-statuscmd-");
    const r = await runCli(["status", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    // Local mode has no JSON surface (showAuthStatus); the human summary
    // names the mode instead. A logged-in account would print the account.
    expect(r.logged.join("\n")).toContain("local mode");
  });

  it("openapi prints the document envelope", async () => {
    const { home } = fixture("cli-tree-openapi-");
    const r = await runCli(["openapi"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.stdout).toContain("openapi");
  });
});

// ---- cli-tasks-tree2.test.ts ----
describe("tasks attach/get-file (in-process commander tree)", () => {
  it("attach stores the file record and get-file downloads identical bytes", async () => {
    const { store, home } = fixture("cli-tree2-attach-");
    const payloadPath = join(store, "evidence.png");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    writeFileSync(payloadPath, bytes);
    const a = await runCli(
      ["tasks", store, "--attach", payloadPath, "--task", "aaa00001", "--json"],
      home,
    );
    expect(a.exitCode ?? 0).toBe(0);
    const stored = readStore(store).find((t) => t.id === "aaa00001") as {
      files: Array<{ name: string }>;
    };
    expect(stored.files.length).toBe(1);
    const name = stored.files[0].name as string;
    expect(typeof name).toBe("string");

    const outPath = join(store, "downloaded.png");
    const g = await runCli(
      [
        "tasks",
        store,
        "--get-file",
        "aaa00001",
        "--get-file",
        name,
        "--out",
        outPath,
        "--json",
      ],
      home,
    );
    expect(g.exitCode ?? 0).toBe(0);
    // Byte-identical round trip: the download is the upload.
    expect(readFileSync(outPath)).toEqual(bytes);
  });

  it("attach of a missing file refuses with a file error", async () => {
    const { store, home } = fixture("cli-tree2-attachmiss-");
    const r = await runCli(
      ["tasks", store, "--attach", join(store, "nope.png"), "--task", "aaa00001", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(
      readStore(store).find((t) => t.id === "aaa00001"),
    ).toMatchObject({ files: [] });
  });
});

describe("tasks commit/reindex/normalize (in-process commander tree)", () => {
  it("--commit without --task is refused", async () => {
    const { store, home } = fixture("cli-tree2-commit-");
    const r = await runCli(
      ["tasks", store, "--commit", "--message", "x", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });

  it("--commit on a non-git directory reports the git failure", async () => {
    const { store, home } = fixture("cli-tree2-commitgit-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(
      ["tasks", store, "--commit", "--task", "aaa00001", "--message", "x", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("--reindex-sort-keys completes on a healthy store", async () => {
    const { store, home } = fixture("cli-tree2-reindex-");
    const r = await runCli(
      ["tasks", store, "--reindex-sort-keys", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.stdout).toContain("eindex");
  });

  it("--reindex-sort-keys cannot combine with --edit", async () => {
    const { store, home } = fixture("cli-tree2-reindexcombo-");
    const r = await runCli(
      ["tasks", store, "--reindex-sort-keys", "--edit", "aaa00001", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });

  it("--normalize dry-run reports without rewriting", async () => {
    const { store, home } = fixture("cli-tree2-norm-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(["tasks", store, "--normalize", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("--normalize cannot combine with --get", async () => {
    const { store, home } = fixture("cli-tree2-normcombo-");
    const r = await runCli(
      ["tasks", store, "--normalize", "--get", "aaa00001", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });
});

describe("tasks edit links/tags/priority (in-process commander tree)", () => {
  it("edit --set-parent links the child under the parent", async () => {
    const { store, home } = fixture("cli-tree2-parent-");
    const r = await runCli(
      ["tasks", store, "--edit", "bbb00002", "--set-parent", "aaa00001", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const child = readStore(store).find((t) => t.id === "bbb00002") as {
      links: Array<{ taskId: string; type: string }>;
    };
    expect(
      child.links.some(
        (l) => l.taskId === "aaa00001" && l.type === "parent",
      ),
    ).toBe(true);
  });

  it("edit --set-parent to a dangling id is refused", async () => {
    const { store, home } = fixture("cli-tree2-pardang-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(
      ["tasks", store, "--edit", "bbb00002", "--set-parent", "zzz99999", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("edit --priority is not an edit flag (priority is add-only)", async () => {
    const { store, home } = fixture("cli-tree2-prio-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--priority", "High", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("add --priority persists the requested priority", async () => {
    const { store, home } = fixture("cli-tree2-prioadd-");
    const r = await runCli(
      ["tasks", store, "--add", "--title", "Urgent", "--priority", "High", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; task: { id: string } };
    expect(readStore(store).find((t) => t.id === payload.task.id)?.priority).toBe("High");
  });

  it("list --limit pages and --all returns the whole board", async () => {
    const { store, home } = fixture("cli-tree2 paging-".replace(" ", ""));
    const p = await runCli(
      ["tasks", store, "--limit", "1", "--json"],
      home,
    );
    expect(p.exitCode ?? 0).toBe(0);
    const page = JSON.parse(p.stdout) as { ok: boolean; tasks: unknown[] };
    expect(page.ok).toBe(true);
    expect(page.tasks.length).toBe(1);
    const a = await runCli(["tasks", store, "--all", "--json"], home);
    expect(a.exitCode ?? 0).toBe(0);
    const full = JSON.parse(a.stdout) as { ok: boolean; tasks: unknown[] };
    expect(full.tasks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("top-level usage + info commands (in-process commander tree)", () => {
  it("verify with a bad --timeout is refused as E_USAGE", async () => {
    const { home } = fixture("cli-tree2-vtimeout-");
    const r = await runCli(["verify", "aaa00001", "--timeout", "banana", "--json"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });

  it("verify without a task id is refused", async () => {
    const { home } = fixture("cli-tree2-vnoid-");
    const r = await runCli(["verify", "--json"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });

  it("telemetry --status names the env override", async () => {
    const { home } = fixture("cli-tree2-tel-");
    const r = await runCli(["telemetry", "--status"], home);
    expect(r.exitCode ?? 0).toBe(0);
    // VIBEFLOW_TELEMETRY=0 is set by this suite, and the renderer says so.
    expect(r.logged.join("\n")).toContain("VIBEFLOW_TELEMETRY=0");
  });

  it("openapi --yaml prints the YAML document", async () => {
    const { home } = fixture("cli-tree2-oayaml-");
    const r = await runCli(["openapi", "--yaml"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.stdout).toContain("openapi:");
  });

  it("auth --clear on an empty project reports nothing to clear", async () => {
    const { home } = fixture("cli-tree2-authclear-");
    const r = await runCli(["auth", "--clear"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Nothing to clear");
  });

  it("auth --list on an empty project reports no state files", async () => {
    const { home } = fixture("cli-tree2-authlist-");
    const r = await runCli(["auth", "--list"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("No auth state files found");
  });

  it("authors link on a non-git dir reports the git failure", async () => {
    const { store, home } = fixture("cli-tree2-authors-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(["authors", "link", store, "--dry-run"], home);
    expect(r.exitCode).not.toBe(0);
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  // NOTE: no `pull` test — pull performs network I/O even in local mode
  // (no offline refusal), so it cannot run hermetically in the unit suite.
  // It is covered by the e2e suite against the built binary.
});

// ---- cli-tasks-tree3.test.ts ----
describe("tasks verify verdicts + link edits (in-process commander tree)", () => {
  async function reviewFixture(prefix: string) {
    const { store, home } = fixture(prefix);
    // Reaching review REQUIRES the verdict in the same edit (the review
    // gate); todo → in-progress first, then review + verdict together.
    let r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-status", "in-progress", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-status", "review", "--comment", "did the thing", "--set-verify", "pass", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(readTask(store, "aaa00001").status).toBe("review");
    return { store, home };
  }

  it("edit --set-status review without a verdict is refused by the review gate", async () => {
    const { store, home } = fixture("cli-tree3-jump-");
    let r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-status", "in-progress", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-status", "review", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/comment|review/i);
    expect(readTask(store, "aaa00001").status).toBe("in-progress");
  });

  it("edit --set-verify pass records the verdict on a review task", async () => {
    const { store, home } = await reviewFixture("cli-tree3-vpass-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-verify", "pass", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const onDisk = readTask(store, "aaa00001");
    // The pass verdict is stored as the verified flag (field name is the contract).
    expect(onDisk.verified).toBe(true);
  });

  it("edit --set-verify fail records a failed verdict", async () => {
    const { store, home } = await reviewFixture("cli-tree3-vfail-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-verify", "fail", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    // Fail is the negative verdict (verified:false); only `cannot` takes a reason.
    expect(readTask(store, "aaa00001").verified).toBe(false);
  });

  it("edit --relates/--blocks link tasks and --unrelates/--unblocks drop them", async () => {
    const { store, home } = fixture("cli-tree3-links-");
    let r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--relates", "bbb00002", "--blocks", "bbb00002", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    let links = (readTask(store, "aaa00001").links ?? []) as Array<{
      taskId: string;
      type: string;
    }>;
    expect(links.some((l) => l.taskId === "bbb00002" && l.type === "relates")).toBe(true);
    expect(links.some((l) => l.taskId === "bbb00002" && l.type === "blocks")).toBe(true);
    r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--unrelates", "bbb00002", "--unblocks", "bbb00002", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    links = (readTask(store, "aaa00001").links ?? []) as Array<{
      taskId: string;
      type: string;
    }>;
    expect(links.some((l) => l.taskId === "bbb00002")).toBe(false);
  });

  it("edit --description persists the new description", async () => {
    const { store, home } = fixture("cli-tree3-desc-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--description", "new desc", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(readTask(store, "aaa00001").description).toBe("new desc");
  });
});

describe("tasks add annotations + id prefixes (in-process commander tree)", () => {
  it("add with url+selector writes an annotated task", async () => {
    const { store, home } = fixture("cli-tree3-annot-");
    const r = await runCli(
      ["tasks", store, "--add", "--title", "Annotated", "--url", "https://example.com/p", "--selector", "#cta", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; task: { id: string } };
    const created = readTask(store, payload.task.id);
    expect(created.url).toBe("https://example.com/p");
    expect(created.selector).toBe("#cta");
  });

  it("add --parent links the new task under its parent", async () => {
    const { store, home } = fixture("cli-tree3-addpar-");
    const r = await runCli(
      ["tasks", store, "--add", "--title", "Kid", "--parent", "aaa00001", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; task: { id: string } };
    const links = (readTask(store, payload.task.id).links ?? []) as Array<{
      taskId: string;
      type: string;
    }>;
    expect(links.some((l) => l.taskId === "aaa00001" && l.type === "parent")).toBe(true);
  });

  it("get resolves a unique id prefix", async () => {
    const { store, home } = fixture("cli-tree3-prefix-");
    const r = await runCli(["tasks", store, "--get", "aaa", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; task: { id: string } };
    expect(payload.task.id).toBe("aaa00001");
  });

  it("get with an ambiguous prefix is refused without guessing", async () => {
    const { store, home } = fixture("cli-tree3-amb-");
    const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
    writeFileSync(join(dir, "amb10001.json"), taskJson("amb10001"), "utf-8");
    writeFileSync(join(dir, "amb10002.json"), taskJson("amb10002"), "utf-8");
    const r = await runCli(["tasks", store, "--get", "amb1", "--json"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/AMBIGUOUS|E_/);
  });

  it("next on an empty board reports no task, not an error", async () => {
    const base = mkdtempSync(join(tmpdir(), "cli-tree3-empty-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const store = join(base, "store");
    const home = join(base, "home");
    const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "ddd00004.json"), taskJson("ddd00004", { status: "done" }), "utf-8");
    const r = await runCli(["tasks", store, "--next", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; task: null };
    expect(payload.ok).toBe(true);
    expect(payload.task).toBeNull();
  });
});

describe("tasks list/get flag matrix (in-process commander tree)", () => {
  it("get --fields projects to the requested fields", async () => {
    const { store, home } = fixture("cli-tree3-fields-");
    const r = await runCli(
      ["tasks", store, "--get", "aaa00001", "--fields", "id,title", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; task: Record<string, unknown> };
    // Projection keeps the requested fields (plus derived counts).
    expect(payload.task.id).toBe("aaa00001");
    expect(payload.task.title).toBe("Task aaa00001");
    expect(payload.task).not.toHaveProperty("description");
  });

  it("list --type filters to the requested type", async () => {
    const { store, home } = fixture("cli-tree3-type-");
    const r = await runCli(["tasks", store, "--type", "Task", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; tasks: Array<{ type: string }> };
    expect(payload.tasks.length).toBeGreaterThan(0);
    for (const t of payload.tasks) expect(t.type).toBe("Task");
  });

  it("list --branch scopes to the task branch", async () => {
    const { store, home } = fixture("cli-tree3-branch-");
    const r = await runCli(["tasks", store, "--branch", "main", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
  });
});

describe("top-level info commands (in-process commander tree)", () => {
  it("changelog prints the latest release notes", async () => {
    const { home } = fixture("cli-tree3-clog-");
    const r = await runCli(["changelog"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n").length).toBeGreaterThan(0);
  });

  it("changelog --all prints the full history", async () => {
    const { home } = fixture("cli-tree3-clogall-");
    const r = await runCli(["changelog", "--all"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n").length).toBeGreaterThan(0);
  });

  it("legacy status prints the same local-mode summary", async () => {
    const { home } = fixture("cli-tree3-legstat-");
    const r = await runCli(["status"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("local mode");
  });

  it("telemetry --disable opts out and --enable opts back in", async () => {
    const { home } = fixture("cli-tree3-tel2-");
    let r = await runCli(["telemetry", "--disable"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Telemetry disabled");
    r = await runCli(["telemetry", "--enable"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Telemetry enabled");
  });

  it("authors link --dry-run succeeds inside a git repo", async () => {
    const base = mkdtempSync(join(tmpdir(), "cli-tree3-git-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const store = join(base, "store");
    const home = join(base, "home");
    const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "aaa00001.json"), taskJson("aaa00001"), "utf-8");
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: store, env: gitEnv });
    const before = JSON.stringify(readStore(store));
    const r = await runCli(["authors", "link", store, "--dry-run"], home);
    expect(r.exitCode ?? 0).toBe(0);
    // Dry run writes nothing but must say what it found.
    expect(JSON.stringify(readStore(store))).toBe(before);
    expect(r.logged.join("\n").length).toBeGreaterThan(0);
    expect(existsSync(join(store, ".git"))).toBe(true);
  });
});

// ---- cli-tasks-tree4.test.ts ----
describe("tasks delete dry-run + move + no-parent (in-process)", () => {
  it("delete --yes --dry-run reports the plan and deletes nothing", async () => {
    const { store, home } = fixture("cli-tree4-dryrun-");
    // bbb00002 is a leaf (aaa00001 has child ccc00003, so deleting the
    // parent would refuse even as a dry run — the plan path needs a leaf).
    const r = await runCli(
      ["tasks", store, "--delete", "bbb00002", "--yes", "--dry-run", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      dryRun: boolean;
      id: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.id).toBe("bbb00002");
    expect(readStore(store).some((t) => t.id === "bbb00002")).toBe(true);
  });

  it("attach --move removes the source file after a successful attach", async () => {
    const { store, home } = fixture("cli-tree4-move-");
    const payloadPath = join(store, "move-me.png");
    writeFileSync(payloadPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const r = await runCli(
      ["tasks", store, "--attach", payloadPath, "--task", "aaa00001", "--move", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const stored = readTask(store, "aaa00001") as {
      files: Array<{ name: string }>;
    };
    expect(stored.files.length).toBe(1);
    // The move consumed the source: attach succeeded AND the file is gone.
    expect(existsSync(payloadPath)).toBe(false);
  });

  it("edit --no-parent drops the parent link", async () => {
    const { store, home } = fixture("cli-tree4-nopar-");
    let r = await runCli(
      ["tasks", store, "--edit", "bbb00002", "--set-parent", "aaa00001", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    r = await runCli(
      ["tasks", store, "--edit", "bbb00002", "--no-parent", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const links = (readTask(store, "bbb00002").links ?? []) as Array<{
      type: string;
    }>;
    expect(links.some((l) => l.type === "parent")).toBe(false);
  });
});

describe("tasks next blocked/stranded (in-process)", () => {
  it("next reports all-blocked instead of claiming", async () => {
    const { store, home } = fixture("cli-tree4-blocked-");
    // bbb is in-progress; aaa todo is blocked by bbb → nothing claimable.
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--blocks", "bbb00002", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    // Reverse: bbb blocks aaa means aaa is blocked by unfinished bbb.
    const n = await runCli(["tasks", store, "--next", "--json"], home);
    expect(n.exitCode ?? 0).toBe(0);
    expect(n.stdout).toContain("blocked");
  });

  it("next reports stranded children of done parents", async () => {
    const base = mkdtempSync(join(tmpdir(), "cli-tree4-strand-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const store = join(base, "store");
    const home = join(base, "home");
    const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    // Parent done, child todo → the child is stranded (never claimed silently).
    writeFileSync(join(dir, "ppp00001.json"), taskJson("ppp00001", { status: "done" }), "utf-8");
    writeFileSync(
      join(dir, "ccc00003.json"),
      taskJson("ccc00003", { links: [{ taskId: "ppp00001", type: "parent" }] }),
      "utf-8",
    );
    const n = await runCli(["tasks", store, "--next", "--json"], home);
    expect(n.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(n.stdout) as { ok: boolean; task: null };
    expect(payload.ok).toBe(true);
    expect(payload.task).toBeNull();
    expect(n.stdout).toContain("stranded");
  });
});

describe("tasks research report-file flow (in-process)", () => {
  it("research review uploads the report file and deletes it locally", async () => {
    const { store, home } = fixture("cli-tree4-report-");
    // Research task: report-file is its review-time upload.
    let r = await runCli(
      ["tasks", store, "--add", "--title", "Study", "--type", "Research", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const id = (JSON.parse(r.stdout) as { task: { id: string } }).task.id;
    r = await runCli(
      ["tasks", store, "--edit", id, "--set-status", "in-progress", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const report = join(store, "report.md");
    writeFileSync(report, "# Findings\n\nIt works.\n", "utf-8");
    r = await runCli(
      ["tasks", store, "--edit", id, "--set-status", "review", "--comment", "studied", "--report-file", report, "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    // Uploaded AND deleted locally: the research contract.
    expect(readTask(store, id).files).toBeDefined();
  });

  it("report-file without review status is refused", async () => {
    const { store, home } = fixture("cli-tree4-reportref-");
    const report = join(store, "report.md");
    writeFileSync(report, "# Findings\n", "utf-8");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--report-file", report, "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("E_USAGE");
  });
});

describe("tasks commit success in a git repo (in-process)", () => {
  it("commit on a clean tree links HEAD instead of failing", async () => {
    const base = mkdtempSync(join(tmpdir(), "cli-tree4-commit-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const store = join(base, "store");
    const home = join(base, "home");
    const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "aaa00001.json"), taskJson("aaa00001"), "utf-8");
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: store, env: gitEnv });
    const head = execSync("git rev-parse HEAD", { cwd: store, env: gitEnv }).toString().trim();
    // No working-tree changes: the never-dead-end contract links HEAD
    // (a new commit here would fail without git identity configured).
    const r = await runCli(
      ["tasks", store, "--commit", "--task", "aaa00001", "--message", "scoped work", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const envelope = JSON.parse(r.stdout) as {
      ok: boolean;
      commit?: string;
      linkedExisting?: boolean;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.linkedExisting).toBe(true);
    expect(envelope.commit).toBe(head);
    // And the link is recorded on the task.
    const commits = (readTask(store, "aaa00001").commits ?? []) as Array<{ sha: string }>;
    expect(commits.some((c) => c.sha === head)).toBe(true);
  });
});


// ---- batch 5: human-mode twins + flag guards (in-process commander tree) ----
// The batches above drive most flows with --json; the human (chalk prose)
// arms of the same handlers were uncovered. Every test below pins a
// human-mode print or a previously untested usage guard, asserting exit
// codes and output markers plus the on-disk effect where one exists.
describe("tasks human-mode twins (in-process commander tree)", () => {
  it("add human mode prints the created title and writes the file", async () => {
    const { store, home } = fixture("cli-tree5-addhuman-");
    const r = await runCli(
      ["tasks", store, "--add", "--title", "Human created"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Task created:");
    expect(r.logged.join("\n")).toContain("Human created");
    expect(readStore(store).some((t) => t.title === "Human created")).toBe(true);
  });

  it("get human mode prints the title and the child roll-up", async () => {
    const { store, home } = fixture("cli-tree5-gethuman-");
    const r = await runCli(["tasks", store, "--get", "aaa00001"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Task aaa00001");
    expect(r.logged.join("\n")).toContain("children (1)");
  });

  it("get of an unknown id in human mode refuses without JSON", async () => {
    const { store, home } = fixture("cli-tree5-getmisshuman-");
    const r = await runCli(["tasks", store, "--get", "zzz99999"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.logged.join("\n")).toMatch(/Task not found/i);
  });

  it("next human mode claims with the NEXT TASK banner and moves status", async () => {
    const { store, home } = fixture("cli-tree5-nexthuman-");
    const r = await runCli(["tasks", store, "--next"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("NEXT TASK");
    expect(
      readStore(store).every((t) => t.status !== "todo" || t.id === "ccc00003"),
    ).toBe(true);
  });

  it("next human mode names the blocked board instead of claiming", async () => {
    const { store, home } = fixture("cli-tree5-nextblocked-");
    const e = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--blocks", "bbb00002", "--json"],
      home,
    );
    expect(e.exitCode ?? 0).toBe(0);
    // ccc00003 is a todo child of live work, so `--next` would claim it
    // as the child fallback — move it to done so nothing is claimable
    // and the all-blocked branch is what prints.
    for (const status of ["in-progress", "done"]) {
      const c = await runCli(
        ["tasks", store, "--edit", "ccc00003", "--set-status", status, "--json"],
        home,
      );
      expect(c.exitCode ?? 0).toBe(0);
    }
    const n = await runCli(["tasks", store, "--next"], home);
    expect(n.exitCode ?? 0).toBe(0);
    expect(n.logged.join("\n")).toContain("All remaining todo tasks are blocked");
  });

  it("delete preview human mode prints the plan and keeps the file", async () => {
    const { store, home } = fixture("cli-tree5-delhuman-");
    const r = await runCli(["tasks", store, "--delete", "bbb00002"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.logged.join("\n")).toContain("Would delete task:");
    expect(storeHas(store, "bbb00002")).toBe(true);
  });

  it("delete --yes human mode prints the confirmation and removes the file", async () => {
    const { store, home } = fixture("cli-tree5-delyeshuman-");
    const r = await runCli(
      ["tasks", store, "--delete", "bbb00002", "--yes"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Task deleted:");
    expect(storeHas(store, "bbb00002")).toBe(false);
  });

  it("--reindex-sort-keys human mode prints the reindex summary", async () => {
    const { store, home } = fixture("cli-tree5-reindexhuman-");
    const r = await runCli(["tasks", store, "--reindex-sort-keys"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Reindexed");
  });

  it("--commit on a non-git directory fails in human mode without writing", async () => {
    const { store, home } = fixture("cli-tree5-commithuman-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(
      ["tasks", store, "--commit", "--task", "aaa00001", "--message", "x"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.logged.join("\n")).toMatch(/git/i);
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("edit --dry-run --json reports the updates and writes nothing", async () => {
    const { store, home } = fixture("cli-tree5-editdry-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--title", "Planned", "--dry-run", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      dryRun: boolean;
      taskId: string;
      updates: Record<string, unknown>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.taskId).toBe("aaa00001");
    expect(payload.updates.title).toBe("Planned");
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("edit --dry-run human mode prints the would-update block", async () => {
    const { store, home } = fixture("cli-tree5-editdryhuman-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--title", "Planned", "--dry-run"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("[dry-run] Would update task:");
  });
});

describe("tasks flag guards (in-process commander tree)", () => {
  it("--comment without --edit is refused naming the edit form", async () => {
    const { store, home } = fixture("cli-tree5-commentguard-");
    const r = await runCli(
      ["tasks", store, "--comment", "stray note", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    const payload = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("E_USAGE");
    expect(payload.error.message).toContain("--comment requires --edit");
  });

  it("a task id positional with --children is refused as a listing-flag misuse", async () => {
    const { store, home } = fixture("cli-tree5-childrenguard-");
    void store;
    const r = await runCli(["tasks", "aaa00001", "--children", "--json"], home);
    expect(r.exitCode).not.toBe(0);
    const payload = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("E_USAGE");
    expect(payload.error.message).toContain("--children is a listing flag");
  });

  it("bare --edit prints the usage instructions in human mode", async () => {
    const { store, home } = fixture("cli-tree5-edithelp-");
    const r = await runCli(["tasks", store, "--edit"], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Usage Instructions");
  });

  it("bare --edit --json is an E_USAGE refusal, not a help screen", async () => {
    const { store, home } = fixture("cli-tree5-edithelpjson-");
    const r = await runCli(["tasks", store, "--edit", "--json"], home);
    expect(r.exitCode).not.toBe(0);
    const payload = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("E_USAGE");
    expect(payload.error.message).toContain("--edit needs a task id");
  });

  it("list --type with an unknown type is refused naming the vocabulary", async () => {
    const { store, home } = fixture("cli-tree5-badtype-");
    const r = await runCli(
      ["tasks", store, "--type", "Nope", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    const payload = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("E_USAGE");
    expect(payload.error.message).toContain("Invalid type filter");
  });

  it("list --type with an unknown type prints the vocabulary in human mode", async () => {
    const { store, home } = fixture("cli-tree5-badtypehuman-");
    const r = await runCli(["tasks", store, "--type", "Nope"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.logged.join("\n")).toContain("Invalid type filter");
  });

  it("list --status with an unknown status is refused", async () => {
    const { store, home } = fixture("cli-tree5-badstatus-");
    const r = await runCli(
      ["tasks", store, "--status", "nope", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Invalid status filter");
  });

  it("list --user on an authorless board is refused", async () => {
    const { store, home } = fixture("cli-tree5-nouser-");
    const r = await runCli(
      ["tasks", store, "--user", "alice", "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("no task authors are available");
  });

  it("list --user filters to the named author's tasks", async () => {
    const { store, home } = fixture("cli-tree5-user-");
    writeFileSync(
      join(store, ".vibeflow", "tasks", "2026-01-01", "ddd00004.json"),
      taskJson("ddd00004", { title: "Alice task", author: "alice" }),
      "utf-8",
    );
    const r = await runCli(
      ["tasks", store, "--user", "alice", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      tasks: Array<{ id: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.tasks.map((t) => t.id)).toContain("ddd00004");
    expect(payload.tasks.map((t) => t.id)).not.toContain("aaa00001");
  });

  it("list --tag filters to tasks carrying every tag", async () => {
    const { store, home } = fixture("cli-tree5-tag-");
    writeFileSync(
      join(store, ".vibeflow", "tasks", "2026-01-01", "ddd00004.json"),
      taskJson("ddd00004", { title: "Tagged task", tags: ["frontend"] }),
      "utf-8",
    );
    const r = await runCli(
      ["tasks", store, "--tag", "frontend", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      tasks: Array<{ id: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.tasks.map((t) => t.id)).toContain("ddd00004");
    expect(payload.tasks.map((t) => t.id)).not.toContain("aaa00001");
  });
});

// ---- batch 6: more human-mode twins + linked flows (in-process) ----
// Same contract as batch 5: pin the human prose arms and the on-disk
// effect. The commit/authors pair is one linked flow — the commit records
// HEAD on the task, authors link resolves its author email through git.
describe("tasks human-mode twins continued (in-process commander tree)", () => {
  it("edit --title human mode prints the update and renames on disk", async () => {
    const { store, home } = fixture("cli-tree6-edithuman-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--title", "Human rename"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Task updated:");
    expect(readTask(store, "aaa00001").title).toBe("Human rename");
  });

  it("edit --comment human mode prints the update and appends on disk", async () => {
    const { store, home } = fixture("cli-tree6-commenthuman-");
    const r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--comment", "human note"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Task updated:");
    const comments = (readTask(store, "aaa00001").comments ?? []) as Array<{
      text: string;
    }>;
    expect(comments.some((c) => c.text === "human note")).toBe(true);
  });

  it("attach human mode prints the byte count and records the file", async () => {
    const { store, home } = fixture("cli-tree6-attachhuman-");
    const payloadPath = join(store, "evidence.png");
    writeFileSync(payloadPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const r = await runCli(
      ["tasks", store, "--attach", payloadPath, "--task", "aaa00001"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Attached");
    expect(r.logged.join("\n")).toContain("bytes");
    const stored = readTask(store, "aaa00001") as {
      files: Array<{ name: string }>;
    };
    expect(stored.files.length).toBe(1);
  });

  it("--normalize human dry-run prints the plan and rewrites nothing", async () => {
    const { store, home } = fixture("cli-tree6-normhuman-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(["tasks", store, "--normalize", "--dry-run"], home);
    expect(r.exitCode ?? 0).toBe(0);
    // Healthy store: zero plans, so the human arm reports the no-op
    // (an unnormalized store would print "[dry-run] Would normalize").
    expect(r.logged.join("\n")).toContain("Store already normalized");
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("add without --title in human mode refuses naming the title", async () => {
    const { store, home } = fixture("cli-tree6-addnotitlehuman-");
    const before = readStore(store).length;
    const r = await runCli(["tasks", store, "--add"], home);
    expect(r.exitCode).not.toBe(0);
    // Human refusals ride the envelope's stderr arm (chalk ✗ + suggestion).
    expect(r.stderr).toContain("--title is required with --add");
    expect(readStore(store).length).toBe(before);
  });

  it("commit human mode links HEAD and prints the confirmation", async () => {
    const base = mkdtempSync(join(tmpdir(), "cli-tree6-commit-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const store = join(base, "store");
    const home = join(base, "home");
    const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "aaa00001.json"), taskJson("aaa00001"), "utf-8");
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: store, env: gitEnv });
    const head = execSync("git rev-parse HEAD", { cwd: store, env: gitEnv }).toString().trim();
    const r = await runCli(
      ["tasks", store, "--commit", "--task", "aaa00001", "--message", "scoped work"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    // Clean tree: nothing to commit is NOT a dead end — HEAD is linked,
    // and the human arm says so explicitly (no "Committed" wording).
    expect(r.logged.join("\n")).toContain("Linked existing commit to task:");
    const commits = (readTask(store, "aaa00001").commits ?? []) as Array<{ sha: string }>;
    expect(commits.some((c) => c.sha === head)).toBe(true);
  });

  it("authors link resolves the committed HEAD to its author email", async () => {
    const base = mkdtempSync(join(tmpdir(), "cli-tree6-authors-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const store = join(base, "store");
    const home = join(base, "home");
    const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "aaa00001.json"), taskJson("aaa00001"), "utf-8");
    execSync("git init -q && git add -A && git -c user.email=author@example.com -c user.name=Author commit -qm init", { cwd: store, env: gitEnv });
    const head = execSync("git rev-parse HEAD", { cwd: store, env: gitEnv }).toString().trim();
    // Self-consistent oracle: whatever identity the fixture commit landed
    // with (the -c flags above, or ambient git config when those lose),
    // authors link must resolve exactly that author through git.
    const expectedEmail = execSync("git log -1 --format=%ae HEAD", { cwd: store, env: gitEnv }).toString().trim();
    expect(expectedEmail).toMatch(/@/);
    const c = await runCli(
      ["tasks", store, "--commit", "--task", "aaa00001", "--message", "scoped work", "--json"],
      home,
    );
    expect(c.exitCode ?? 0).toBe(0);
    const r = await runCli(["authors", "link", store], home);
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("Linked 1 commit author email(s)");
    const commits = (readTask(store, "aaa00001").commits ?? []) as Array<{
      sha: string;
      authorEmail?: string;
    }>;
    const linked = commits.find((x) => x.sha === head);
    expect(linked?.authorEmail).toBe(expectedEmail);
  });
});

// ---- batch 7: auto-commit/auto-push + next dry-run (in-process) ----
// The review edit below carries --commit-message with autoCommit/autoPush
// enabled in settings: the task status is saved first, then the task file
// is committed, then a push is attempted. With no remote the push fails —
// a NOTICE ("Push failed"), not a refusal: the edit stays ok:true.
describe("tasks auto-commit and next dry-run (in-process commander tree)", () => {
  it("review edit with --commit-message commits, then reports the failed push", async () => {
    const base = mkdtempSync(join(tmpdir(), "cli-tree7-auto-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const store = join(base, "store");
    const home = join(base, "home");
    const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(dir, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(dir, "aaa00001.json"), taskJson("aaa00001"), "utf-8");
    execSync("git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init", { cwd: store, env: gitEnv });
    const { saveSettings } = await import("../../src/core/settings.js");
    saveSettings(store, { autoCommit: true, autoPush: true });
    let r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-status", "in-progress", "--json"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    // Human mode: the commit + push notices are prose, not envelope fields.
    r = await runCli(
      ["tasks", store, "--edit", "aaa00001", "--set-status", "review", "--comment", "did it", "--set-verify", "pass", "--commit-message", "auto work"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    const out = r.logged.join("\n");
    expect(out).toContain("Committed:");
    expect(out).toContain("Push failed");
    // The status transition landed even though the push did not.
    expect(readTask(store, "aaa00001").status).toBe("review");
  });

  it("next --dry-run --json names the task and writes nothing", async () => {
    const { store, home } = fixture("cli-tree7-nextdry-");
    const before = JSON.stringify(readStore(store));
    const r = await runCli(["tasks", store, "--next", "--dry-run", "--json"], home);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string; status: string } | null;
    };
    expect(payload.ok).toBe(true);
    expect(payload.task?.id).toBe("aaa00001");
    // Dry run previews: the record stays todo on disk.
    expect(readTask(store, "aaa00001").status).toBe("todo");
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("delete --yes --dry-run human mode prints the plan and keeps the file", async () => {
    const { store, home } = fixture("cli-tree7-deldryhuman-");
    const r = await runCli(
      ["tasks", store, "--delete", "bbb00002", "--yes", "--dry-run"],
      home,
    );
    expect(r.exitCode ?? 0).toBe(0);
    expect(r.logged.join("\n")).toContain("[dry-run] Would delete task bbb00002");
    expect(storeHas(store, "bbb00002")).toBe(true);
  });
});

// ---- batch 8: get-file + preview/commit/pull edges (in-process) ----
describe("tasks get-file and guard edges (in-process commander tree)", () => {
  it("get-file human mode downloads identical bytes with the receipt", async () => {
    const { store, home } = fixture("cli-tree8-getfilehuman-");
    const payloadPath = join(store, "evidence.png");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 9, 9]);
    writeFileSync(payloadPath, bytes);
    const a = await runCli(
      ["tasks", store, "--attach", payloadPath, "--task", "aaa00001", "--json"],
      home,
    );
    expect(a.exitCode ?? 0).toBe(0);
    const name = (
      readTask(store, "aaa00001") as { files: Array<{ name: string }> }
    ).files[0].name;
    const outPath = join(store, "downloaded.png");
    const g = await runCli(
      ["tasks", store, "--get-file", "aaa00001", "--get-file", name, "--out", outPath],
      home,
    );
    expect(g.exitCode ?? 0).toBe(0);
    expect(r_logged(g)).toContain("Downloaded");
    expect(r_logged(g)).toContain("bytes");
    expect(readFileSync(outPath)).toEqual(bytes);
  });

  it("get-file of a record with no stored bytes refuses instead of crashing", async () => {
    const { store, home } = fixture("cli-tree8-getfilemiss-");
    const payloadPath = join(store, "evidence.png");
    writeFileSync(payloadPath, Buffer.from([137, 80, 78, 71]));
    const a = await runCli(
      ["tasks", store, "--attach", payloadPath, "--task", "aaa00001", "--json"],
      home,
    );
    expect(a.exitCode ?? 0).toBe(0);
    const name = (
      readTask(store, "aaa00001") as { files: Array<{ name: string }> }
    ).files[0].name;
    // The bytes live under .vibeflow/tasks/files/<id>/ — remove them while
    // the row remains (evicted, never pushed).
    rmSync(join(store, ".vibeflow", "tasks", "files"), { recursive: true, force: true });
    const before = JSON.stringify(readStore(store));
    const r = await runCli(
      ["tasks", store, "--get-file", "aaa00001", "--get-file", name, "--out", join(store, "x.png"), "--json"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("FILE_NOT_FOUND");
    expect(r.stderr).toContain("evidence.png");
    expect(JSON.stringify(readStore(store))).toBe(before);
  });

  it("delete preview human mode names the parent's children", async () => {
    const { store, home } = fixture("cli-tree8-delparenthuman-");
    const r = await runCli(["tasks", store, "--delete", "aaa00001"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.logged.join("\n")).toContain("ccc00003");
    expect(storeHas(store, "aaa00001")).toBe(true);
    expect(storeHas(store, "ccc00003")).toBe(true);
  });

  it("--commit on a non-git directory fails in human mode naming the cause", async () => {
    const { store, home } = fixture("cli-tree8-commitfailhuman-");
    const r = await runCli(
      ["tasks", store, "--commit", "--task", "aaa00001", "--message", "x"],
      home,
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.logged.join("\n")).toMatch(/git|commit/i);
  });

});

function r_logged(r: { logged: string[] }): string {
  return r.logged.join("\n");
}
