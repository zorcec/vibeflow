/**
 * CLI e2e — a todo child of a non-todo parent must never be invisible.
 *
 * Regression scenario from the owner: parent in backlog, child in todo.
 * Before the fix, `--status todo` hid the child (root-only listing dropped
 * every matching child whose parent did not match), and `--next` reported
 * "No todo tasks found" even though a todo task existed.
 *
 * Contract pinned here:
 *  - a filtered listing (--status/--type/--tag/--user) returns EVERY matching
 *    task, children included, each with parent context;
 *  - the unfiltered listing keeps the root-only default (board parity);
 *  - --next falls back to the highest-priority matching child when no todo
 *    root is claimable, and says explicitly that it claimed a child.
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

  it("--next --json claims the todo child and marks it as a child claim", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const { child } = await seedBacklogParentTodoChild(store, home);

    const r = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect((parsed.task as TaskJson).id).toBe(child.id);
    expect((parsed.task as TaskJson).status).toBe("in-progress");
    // Unambiguous: the payload says this claim is a child, with its parent.
    expect(parsed.childClaim).toBe(true);
    expect(parsed.parent as unknown).toBeDefined();
  });

  it("--next human output says explicitly it claimed a child of a backlog parent", async () => {
    const store = freshDir("child-vis-store-");
    const home = freshDir("child-vis-home-");
    const { parent } = await seedBacklogParentTodoChild(store, home);

    const r = await spawnCli(["tasks", store, "--next"], { cwd: store, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Todo child");
    expect(r.stdout.toLowerCase()).toContain("child");
    expect(r.stdout).toContain(parent.id.slice(0, 8));
    expect(r.stdout).toContain("[backlog]");
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
