/**
 * CLI e2e — `--next` must skip candidates blocked by unfinished work and say so.
 *
 * Ticket 0c0413f7 (follow-up to 4c846d52): `--next` ignored `blocks` links, so
 * once children became claimable it could hand out a todo child blocked by an
 * unfinished gate — in the live store, P6 (delete the legacy log pipeline)
 * blocked by P5's unpassed parity gate. Only `done` satisfies a link.
 *
 * Contract pinned here:
 *  - a todo blocked by a `review` ticket is skipped, and the human output
 *    names it as skipped with its blocker and the blocker's status;
 *  - a todo blocked by a `done` ticket IS claimable (no over-filtering);
 *  - when every candidate is blocked nothing is claimed and the report reads
 *    differently from "no work" (`allBlocked` in --json, "nothing claimed"
 *    in human output).
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCli, seedGitUser } from "./mcp-helpers.js";

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
  title?: string;
  links?: Array<{ taskId: string; type: string }>;
};

async function addTask(
  store: string,
  home: string,
  title: string,
  extra: string[] = [],
): Promise<TaskJson> {
  const r = await spawnCli(
    ["tasks", store, "--add", "--title", title, ...extra, "--json"],
    { cwd: store, home },
  );
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as Envelope).task as TaskJson;
}

async function setStatus(
  store: string,
  home: string,
  id: string,
  status: string,
  extra: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await spawnCli(
    ["tasks", store, "--edit", id, "--set-status", status, ...extra, "--json"],
    { cwd: store, home },
  );
  expect(r.code).toBe(0);
  return r;
}

async function addBlocks(
  store: string,
  home: string,
  id: string,
  blockerId: string,
): Promise<void> {
  const r = await spawnCli(
    ["tasks", store, "--edit", id, "--blocks", blockerId, "--json"],
    { cwd: store, home },
  );
  expect(r.code).toBe(0);
}

async function getStatus(
  store: string,
  home: string,
  id: string,
): Promise<string> {
  const r = await spawnCli(["tasks", store, "--get", id, "--json"], {
    cwd: store,
    home,
  });
  expect(r.code).toBe(0);
  return ((JSON.parse(r.stdout) as Envelope).task as TaskJson).status;
}

/**
 * Gate in review + an in-progress epic + a todo child of the epic blocked by
 * the gate — the P6 shape from the ticket. Review needs a report comment and
 * a commit message, so the store is git-initialised for the auto-commit.
 */
async function seedReviewGateWithBlockedChild(store: string, home: string) {
  seedGitUser(store);
  const gate = await addTask(store, home, "Parity gate");
  await setStatus(store, home, gate.id, "in-progress");
  await setStatus(store, home, gate.id, "review", [
    "--comment",
    "gate evidence attached",
    "--commit-message",
    "gate in review",
  ]);
  const epic = await addTask(store, home, "Decommission epic");
  await setStatus(store, home, epic.id, "in-progress");
  const child = await addTask(store, home, "Delete legacy pipeline", [
    "--parent",
    epic.id,
  ]);
  await addBlocks(store, home, child.id, gate.id);
  return { gate, epic, child };
}

describe("--next skips work blocked by unfinished gates", () => {
  it("--next claims the free root and names the review-blocked child as skipped", async () => {
    const store = freshDir("next-blocked-store-");
    const home = freshDir("next-blocked-home-");
    const { gate, child } = await seedReviewGateWithBlockedChild(store, home);
    const free = await addTask(store, home, "Unblocked root");

    const r = await spawnCli(["tasks", store, "--next"], { cwd: store, home });
    expect(r.code).toBe(0);
    // The free root is claimed …
    expect(r.stdout).toContain("Unblocked root");
    // … and the blocked child is named as skipped, with its blocker.
    expect(r.stdout).toContain("skipped");
    expect(r.stdout).toContain("blocked");
    expect(r.stdout).toContain(child.id.slice(0, 8));
    expect(r.stdout).toContain(gate.id.slice(0, 8));
    expect(r.stdout).toContain("[review]");
    // The blocked child is still todo — nothing destructive was started.
    expect(await getStatus(store, home, child.id)).toBe("todo");
    expect(await getStatus(store, home, free.id)).toBe("in-progress");
  });

  it("--next --json reports the skipped child in blocked with its review gate", async () => {
    const store = freshDir("next-blocked-store-");
    const home = freshDir("next-blocked-home-");
    const { gate, child } = await seedReviewGateWithBlockedChild(store, home);
    const free = await addTask(store, home, "Unblocked root");

    const r = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect((parsed.task as TaskJson).id).toBe(free.id);
    const blocked = parsed.blocked as Array<{
      id: string;
      blockedBy: Array<{ id: string; status: string }>;
    }>;
    expect(blocked.map((b) => b.id)).toContain(child.id);
    const entry = blocked.find((b) => b.id === child.id)!;
    expect(entry.blockedBy.map((b) => b.id)).toContain(gate.id);
    expect(entry.blockedBy[0].status).toBe("review");
  });

  it("all candidates blocked: claims nothing and the report differs from 'no work'", async () => {
    const store = freshDir("next-blocked-store-");
    const home = freshDir("next-blocked-home-");
    const { child } = await seedReviewGateWithBlockedChild(store, home);

    const r = await spawnCli(["tasks", store, "--next"], { cwd: store, home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("blocked");
    expect(r.stdout).toContain(child.id.slice(0, 8));
    expect(r.stdout).toContain("nothing claimed");
    // "No work" and "all work is blocked" must be distinguishable.
    expect(r.stdout).not.toContain("Nothing to work on");
    expect(await getStatus(store, home, child.id)).toBe("todo");

    const j = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(j.code).toBe(0);
    const parsed = JSON.parse(j.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect(parsed.task).toBeNull();
    expect(parsed.allBlocked).toBe(true);
    expect(
      (parsed.blocked as Array<{ id: string }>).map((b) => b.id),
    ).toContain(child.id);
  });

  it("only child of live work is the fallback: childClaim with parent context", async () => {
    // P3 (ticket 6452504d): when no eligible root exists, --next falls back
    // to the todo child of live work and says so explicitly — childClaim
    // plus the parent it was sliced from, on both surfaces.
    const store = freshDir("next-blocked-store-");
    const home = freshDir("next-blocked-home-");
    seedGitUser(store);
    const epic = await addTask(store, home, "Live epic");
    await setStatus(store, home, epic.id, "in-progress");
    const child = await addTask(store, home, "Only child", [
      "--parent",
      epic.id,
    ]);

    const r = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect((parsed.task as TaskJson).id).toBe(child.id);
    expect(parsed.childClaim).toBe(true);
    expect((parsed.parent as { id: string }).id).toBe(epic.id);
    expect(await getStatus(store, home, child.id)).toBe("in-progress");
  });

  it("a todo blocked by a done gate IS claimable (the link is satisfied)", async () => {
    const store = freshDir("next-blocked-store-");
    const home = freshDir("next-blocked-home-");
    seedGitUser(store);
    const gate = await addTask(store, home, "Finished gate");
    await setStatus(store, home, gate.id, "in-progress");
    await setStatus(store, home, gate.id, "done");
    const blocked = await addTask(store, home, "Follow-up work");
    await addBlocks(store, home, blocked.id, gate.id);

    const r = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect((parsed.task as TaskJson).id).toBe(blocked.id);
    expect((parsed.task as TaskJson).status).toBe("in-progress");
  });
});
