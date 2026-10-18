/**
 * CLI e2e — a todo child of a non-todo parent must never be invisible,
 * and must never be auto-claimed off a parked unit.
 *
 * Regression scenario from the owner: parent in backlog, child in todo.
 * Originally `--status todo` hid the child and `--next` reported "No todo
 * tasks found". The listing half was fixed first (filtered listings return
 * every match with parent context); the claim half was then restricted
 * (ticket 4ab7104a): --next refuses children of backlog/done parents and
 * reports them as stranded instead of slicing a fragment off a parked unit.
 *
 * Contract pinned here:
 *  - a filtered listing (--status/--type/--tag/--user) returns EVERY matching
 *    task, children included, each with parent context;
 *  - the unfiltered listing keeps the root-only default (board parity);
 *  - --next refuses a todo child of a backlog parent (task:null) and names
 *    it as stranded, in both --json and human output;
 *  - --next still falls back to a todo child of LIVE work, saying explicitly
 *    that it claimed a child.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
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

type Envelope = { ok: boolean } & Record<string, unknown>;
type TaskJson = { id: string; status: string; links?: Array<{ taskId: string; type: string }> };

async function addTask(
  store: string,
  home: string,
  title: string,
  extra: string[] = [],
): Promise<TaskJson> {
  const r = await spawnCli(["tasks", store, "--add", "--title", title, ...extra, "--json"], {
    cwd: store,
    home,
  });
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as Envelope).task as TaskJson;
}

async function setStatus(store: string, home: string, id: string, status: string): Promise<void> {
  const r = await spawnCli(
    ["tasks", store, "--edit", id, "--set-status", status, "--json"],
    { cwd: store, home },
  );
  expect(r.code).toBe(0);
}

/** Parent in backlog, child in todo — the owner's exact scenario. */
async function seedBacklogParentTodoChild(store: string, home: string) {
  const parent = await addTask(store, home, "Backlog parent");
  await setStatus(store, home, parent.id, "backlog");
  const child = await addTask(store, home, "Todo child", ["--parent", parent.id]);
  return { parent, child };
}

describe("todo child of a backlog parent is visible", () => {
  it("--status todo --json returns the child (hiddenChildren 0)", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const { child } = await seedBacklogParentTodoChild(store, home);

    const r = await spawnCli(["tasks", store, "--status", "todo", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    const ids = (parsed.tasks as TaskJson[]).map((t) => t.id);
    expect(ids).toContain(child.id);
    expect(parsed.hiddenChildren).toBe(0);
  });

  it("--status todo human output shows the child with its backlog parent context", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const { parent, child } = await seedBacklogParentTodoChild(store, home);

    const r = await spawnCli(["tasks", store, "--status", "todo"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(child.id.slice(0, 8));
    expect(r.stdout).toContain("Todo child");
    // Parent context: the relations line names the parent and its status.
    expect(r.stdout).toContain("parent:");
    expect(r.stdout).toContain(parent.id.slice(0, 8));
    expect(r.stdout).toContain("[backlog]");
  });

  it("unfiltered listing keeps the root-only default (board parity)", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const { parent } = await seedBacklogParentTodoChild(store, home);

    const r = await spawnCli(["tasks", store, "--json"], { cwd: store, home });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    // The backlog parent is the only root; the todo child stays hidden here
    // and its count rides the envelope — pass --children or filter to see it.
    expect((parsed.tasks as TaskJson[]).map((t) => t.id)).toEqual([parent.id]);
    expect(parsed.hiddenChildren).toBe(1);
  });

  it("--next --json refuses the todo child of a backlog parent and reports it as stranded", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const { child, parent } = await seedBacklogParentTodoChild(store, home);

    const r = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    // Refused, not sliced off the parked unit — and named, not invisible.
    expect(parsed.task as unknown).toBeNull();
    const stranded = parsed.stranded as Array<{ id: string; parentStatus: string | null }>;
    expect(stranded.map((s) => s.id)).toContain(child.id);
    expect(stranded.find((s) => s.id === child.id)?.parentStatus).toBe("backlog");
    expect(parent.id).toBeDefined();
  });

  it("--next human output names the stranded child instead of claiming it", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const { parent } = await seedBacklogParentTodoChild(store, home);

    const r = await spawnCli(["tasks", store, "--next"], { cwd: store, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Todo child");
    expect(r.stdout.toLowerCase()).toContain("stranded");
    expect(r.stdout).toContain(parent.id.slice(0, 8));
    expect(r.stdout).toContain("[backlog]");
  });

  it("--next --json still falls back to a todo child of live work", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const parent = await addTask(store, home, "Live parent");
    await setStatus(store, home, parent.id, "in-progress");
    const r1 = await spawnCli(
      ["tasks", store, "--add", "--title", "Live child", "--parent", parent.id, "--json"],
      { cwd: store, home },
    );
    expect(r1.code).toBe(0);
    const child = (JSON.parse(r1.stdout) as Envelope).task as TaskJson;

    const r = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    // No todo root is claimable (parent is in-progress), so the fallback
    // takes the child of live work — and says so explicitly.
    expect((parsed.task as TaskJson).id).toBe(child.id);
    expect((parsed.task as TaskJson).status).toBe("in-progress");
    expect(parsed.childClaim).toBe(true);
    expect(parsed.parent as unknown).toBeDefined();
  });

  it("--next still prefers a todo root over a higher-priority todo child", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const { child } = await seedBacklogParentTodoChild(store, home);
    const root = await addTask(store, home, "Todo root");

    const r = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    // Roots first — the unit of work is the root; the child is next in line.
    expect((parsed.task as TaskJson).id).toBe(root.id);
    expect(parsed.childClaim ?? false).toBe(false);
    expect(child.id).not.toBe(root.id);
  });
});
