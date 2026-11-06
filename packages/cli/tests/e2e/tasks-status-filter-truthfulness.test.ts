/**
 * CLI e2e — a `--status` filter never returns a root whose status is not
 * the filtered one (ticket 53c98e06).
 *
 * Incident: the orchestrator drained the board with `tasks --status todo
 * --json`, printed items WITHOUT checking each item's `status` field on a
 * board being mutated concurrently, and reported a backlog root (1b1cd6aa)
 * as a todo. Ground truth after the fact: every listing path (local and
 * remote, --json and human, paged and --all) converges on the ONE shared
 * model `queryTaskList`, which re-filters client-side with an exact
 * `t.status === query.status` AFTER any server `?status=` hint — no code
 * path can return a wrong-status root, and the live board reads truthfully.
 * The tool behaved per contract; the report didn't.
 *
 * The owner still wants the guarantee pinned, so this file asserts it:
 *  - for `--status todo` (and backlog / in-progress / done) EVERY returned
 *    root's `status` is exactly the filtered value (asserted on the raw
 *    JSON, not on eyeballed output);
 *  - roots of every other status are absent from the results;
 *  - `--json` status fields are truthful for roots AND children
 *    (cross-checked against `--get`);
 *  - the pinned child-visibility contract still holds: a todo child of a
 *    backlog parent is listed (with parent context in human output).
 * Deliberately NOT asserted: excluding a matching child of a non-matching
 * parent — that visibility is a pinned owner decision (parity contract
 * 83159002, see tasks-child-visibility.test.ts) and stays.
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
type TaskJson = {
  id: string;
  status: string;
  title: string;
  links?: Array<{ taskId: string; type: string }>;
};

function isRoot(t: TaskJson): boolean {
  return !(t.links ?? []).some((l) => l?.type === "parent" && l?.taskId);
}

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

async function setStatus(
  store: string,
  home: string,
  id: string,
  status: string,
): Promise<void> {
  const r = await spawnCli(
    ["tasks", store, "--edit", id, "--set-status", status, "--json"],
    { cwd: store, home },
  );
  expect(r.code).toBe(0);
}

async function listJson(
  store: string,
  home: string,
  status: string,
): Promise<{ tasks: TaskJson[]; envelope: Envelope }> {
  const r = await spawnCli(["tasks", store, "--status", status, "--json"], {
    cwd: store,
    home,
  });
  expect(r.code).toBe(0);
  const envelope = JSON.parse(r.stdout) as Envelope;
  expect(envelope.ok).toBe(true);
  return { tasks: envelope.tasks as TaskJson[], envelope };
}

async function getStatus(store: string, home: string, id: string): Promise<string> {
  const r = await spawnCli(["tasks", store, "--get", id, "--json"], {
    cwd: store,
    home,
  });
  expect(r.code).toBe(0);
  return ((JSON.parse(r.stdout) as Envelope).task as TaskJson).status;
}

/**
 * One root per status plus riders: a todo child under the backlog parent
 * (pinned visibility case) and a todo child under the todo root.
 */
async function seedBoard(store: string, home: string) {
  const todoRoot = await addTask(store, home, "Status-guard todo root");
  const backlogRoot = await addTask(store, home, "Status-guard backlog root");
  await setStatus(store, home, backlogRoot.id, "backlog");
  const progRoot = await addTask(store, home, "Status-guard in-progress root");
  await setStatus(store, home, progRoot.id, "in-progress");
  const doneRoot = await addTask(store, home, "Status-guard done root");
  await setStatus(store, home, doneRoot.id, "done");
  const rider = await addTask(store, home, "Status-guard todo rider", [
    "--parent",
    backlogRoot.id,
  ]);
  const nested = await addTask(store, home, "Status-guard nested todo", [
    "--parent",
    todoRoot.id,
  ]);
  return { todoRoot, backlogRoot, progRoot, doneRoot, rider, nested };
}

describe("--status filter never returns a wrong-status root", () => {
  it("--status todo --json: every returned root is todo, other roots absent", async () => {
    const store = freshDir("status-guard-store-");
    const home = freshDir("status-guard-home-");
    const { todoRoot, backlogRoot, progRoot, doneRoot, rider, nested } =
      await seedBoard(store, home);

    const { tasks, envelope } = await listJson(store, home, "todo");
    const roots = tasks.filter(isRoot);
    // The guarantee: NEVER a root whose status isn't the filtered one.
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root.status).toBe("todo");
    }
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(todoRoot.id);
    expect(ids).not.toContain(backlogRoot.id);
    expect(ids).not.toContain(progRoot.id);
    expect(ids).not.toContain(doneRoot.id);
    // Pinned visibility case stays: the todo rider under the backlog
    // parent is still listed (it matches the filter itself).
    expect(ids).toContain(rider.id);
    expect(ids).toContain(nested.id);
    expect(envelope.hiddenChildren).toBe(0);
  });

  it("--status backlog --json: every returned root is backlog, todo roots absent", async () => {
    const store = freshDir("status-guard-store-");
    const home = freshDir("status-guard-home-");
    const { todoRoot, backlogRoot, progRoot, doneRoot } =
      await seedBoard(store, home);

    const { tasks } = await listJson(store, home, "backlog");
    const roots = tasks.filter(isRoot);
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root.status).toBe("backlog");
    }
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(backlogRoot.id);
    expect(ids).not.toContain(todoRoot.id);
    expect(ids).not.toContain(progRoot.id);
    expect(ids).not.toContain(doneRoot.id);
  });

  it("--status in-progress --json: every returned root is in-progress", async () => {
    const store = freshDir("status-guard-store-");
    const home = freshDir("status-guard-home-");
    const { todoRoot, backlogRoot, progRoot, doneRoot } =
      await seedBoard(store, home);

    const { tasks } = await listJson(store, home, "in-progress");
    const roots = tasks.filter(isRoot);
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root.status).toBe("in-progress");
    }
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(progRoot.id);
    expect(ids).not.toContain(todoRoot.id);
    expect(ids).not.toContain(backlogRoot.id);
    expect(ids).not.toContain(doneRoot.id);
  });

  it("--status done --json: every returned root is done (full-scan path)", async () => {
    const store = freshDir("status-guard-store-");
    const home = freshDir("status-guard-home-");
    const { todoRoot, backlogRoot, doneRoot } = await seedBoard(store, home);

    // `done` is deliberately NOT server-pushable, so this exercises the
    // full-scan listing path rather than the narrowed fetch.
    const { tasks } = await listJson(store, home, "done");
    const roots = tasks.filter(isRoot);
    expect(roots.length).toBeGreaterThan(0);
    for (const root of roots) {
      expect(root.status).toBe("done");
    }
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain(doneRoot.id);
    expect(ids).not.toContain(todoRoot.id);
    expect(ids).not.toContain(backlogRoot.id);
  });

  it("--json status fields agree with --get for every listed row", async () => {
    const store = freshDir("status-guard-store-");
    const home = freshDir("status-guard-home-");
    await seedBoard(store, home);

    const { tasks } = await listJson(store, home, "todo");
    expect(tasks.length).toBeGreaterThan(0);
    for (const row of tasks) {
      // A truthful status field is what makes the filter membership
      // checkable at all — the original incident was an unchecked field.
      expect(await getStatus(store, home, row.id)).toBe(row.status);
    }
  });

  it("--status todo human output shows the rider with its backlog parent context", async () => {
    const store = freshDir("status-guard-store-");
    const home = freshDir("status-guard-home-");
    const { backlogRoot, rider } = await seedBoard(store, home);

    const r = await spawnCli(["tasks", store, "--status", "todo"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Status-guard todo root");
    expect(r.stdout).toContain("[todo]");
    // The rider is visible WITH parent context, not as a bare row: the
    // relations line names the backlog parent and its true status.
    expect(r.stdout).toContain(rider.id.slice(0, 8));
    expect(r.stdout).toContain("parent:");
    expect(r.stdout).toContain(backlogRoot.id.slice(0, 8));
    expect(r.stdout).toContain("[backlog]");
    // ...but the backlog root itself never renders as a LISTED task row
    // (a `[backlog]` chip before the title marks a listed row; the parent
    // line above carries the chip after the title, as context).
    expect(r.stdout).not.toContain("[backlog] Status-guard backlog root");
  });
});
