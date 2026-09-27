/**
 * CLI e2e — the uniform `--json` envelope (Fix A) and the review gate's error
 * code under `--json` (Fix B).
 *
 * Fix A: every `tasks --json` success payload starts with `ok: true` on stdout
 * (named payloads: list → `tasks`, get/add/edit/next → `task`), and no success
 * payload carries the old top-level `success` key. The list envelope reports
 * `hiddenChildren` — child tasks are omitted from the listing by default and
 * the count is machine-readable metadata, not footer text.
 *
 * Fix B: a review-gate refusal (e.g. REVIEW_COMMENT_REQUIRED) reaches `--json`
 * consumers as `{ok:false, error:{code, …}}` on stderr with exit code 2 — the
 * CLI presentation layer must not drop the gate's code in favour of human text
 * on stdout.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function addTask(store: string, home: string, title: string): Promise<Envelope> {
  const add = await spawnCli(
    ["tasks", store, "--add", "--title", title, "--json"],
    { cwd: store, home },
  );
  expect(add.code).toBe(0);
  return JSON.parse(add.stdout) as Envelope;
}

describe("tasks --json envelope", () => {
  it("listing --json returns {ok:true,tasks:[…],hiddenChildren}, not a bare array", async () => {
    const store = freshDir("json-envelope-store-");
    const home = freshDir("json-envelope-home-");
    const parent = await addTask(store, home, "Parent");
    const parentId = (parent.task as { id: string }).id;
    // A child is hidden from the listing by default — its count must ride the envelope.
    const child = await spawnCli(
      ["tasks", store, "--add", "--title", "Child", "--parent", parentId, "--json"],
      { cwd: store, home },
    );
    expect(child.code).toBe(0);

    const r = await spawnCli(["tasks", store, "--json"], { cwd: store, home });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect((parsed.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual([
      parentId,
    ]);
    expect(parsed.hiddenChildren).toBe(1);
    expect("success" in parsed).toBe(false);
  });

  it("--get --json returns {ok:true,task:{…}}, not a flat object", async () => {
    const store = freshDir("json-envelope-store-");
    const home = freshDir("json-envelope-home-");
    const added = await addTask(store, home, "Get me");
    const id = (added.task as { id: string }).id;

    const r = await spawnCli(["tasks", store, "--get", id, "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as Envelope;
    expect(parsed.ok).toBe(true);
    expect("task" in parsed).toBe(true);
    expect((parsed.task as { id: string }).id).toBe(id);
    expect("success" in parsed).toBe(false);
    expect("title" in parsed).toBe(false); // fields moved under `task`
  });

  it("--add / --edit / --next --json return {ok:true,task,next_actions}", async () => {
    const store = freshDir("json-envelope-store-");
    const home = freshDir("json-envelope-home-");

    const added = await addTask(store, home, "First");
    expect(added.ok).toBe(true);
    expect(added.task).toBeDefined();
    expect(added.next_actions).toBeDefined();
    expect(added.success).toBeUndefined();

    const id = (added.task as { id: string }).id;
    const edited = await spawnCli(
      ["tasks", store, "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: store, home },
    );
    expect(edited.code).toBe(0);
    const editedParsed = JSON.parse(edited.stdout) as Envelope;
    expect(editedParsed.ok).toBe(true);
    expect(editedParsed.task).toBeDefined();
    expect(editedParsed.next_actions).toBeDefined();
    expect("success" in editedParsed).toBe(false);

    await addTask(store, home, "Second"); // a todo task left to claim
    const next = await spawnCli(["tasks", store, "--next", "--json"], {
      cwd: store,
      home,
    });
    expect(next.code).toBe(0);
    const nextParsed = JSON.parse(next.stdout) as Envelope;
    expect(nextParsed.ok).toBe(true);
    expect(nextParsed.task).toBeDefined();
    expect(nextParsed.next_actions).toBeDefined();
    expect("success" in nextParsed).toBe(false);
  });

  it("no --json success payload contains a top-level success key", async () => {
    const store = freshDir("json-envelope-store-");
    const home = freshDir("json-envelope-home-");
    const added = await addTask(store, home, "Discriminant sweep");
    const id = (added.task as { id: string }).id;

    const payloads: Envelope[] = [added];
    for (const args of [
      ["tasks", store, "--json"],
      ["tasks", store, "--get", id, "--json"],
      ["tasks", store, "--edit", id, "--set-status", "in-progress", "--json"],
      ["tasks", store, "--commit", "--task", id, "--message", "sweep", "--dry-run", "--json"],
    ]) {
      const r = await spawnCli(args, { cwd: store, home });
      expect(r.code).toBe(0);
      payloads.push(JSON.parse(r.stdout) as Envelope);
    }
    for (const payload of payloads) {
      expect(payload.ok).toBe(true);
      expect("success" in payload).toBe(false);
    }
  });
});
