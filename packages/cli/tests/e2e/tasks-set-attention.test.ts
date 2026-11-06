/**
 * CLI e2e — the needs-attention flag `--set-attention` / `--clear-attention`.
 *
 * `tasks --edit <id> --set-attention --comment "<reason>"` must flag the task
 * (needsAttention=true) and record the comment; the set MUST fail without a
 * comment (non-zero exit, flag untouched) — the comment carries the reason.
 * `--clear-attention` clears the flag with no comment required.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCli } from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function taskFile(projectDir: string, taskId: string): string {
  const tasksDir = join(projectDir, ".vibeflow", "tasks");
  for (const entry of readdirSync(tasksDir)) {
    const candidate = join(tasksDir, entry, `${taskId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`task file not found for ${taskId}`);
}

function stored(projectDir: string, taskId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(taskFile(projectDir, taskId), "utf-8")) as Record<
    string,
    unknown
  >;
}

async function addTask(
  store: string,
  home: string,
  title: string,
): Promise<string> {
  const add = await spawnCli(
    ["tasks", store, "--add", "--title", title, "--json"],
    { cwd: store, home },
  );
  return JSON.parse(add.stdout).task.id;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks --edit --set-attention / --clear-attention", () => {
  it("--set-attention with --comment flags the task and records the comment", async () => {
    const store = freshDir("set-attention-");
    const home = freshDir("set-attention-home-");
    const id = await addTask(store, home, "Needs eyes");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-attention",
        "--comment",
        "blocked on API response shape",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(stored(store, id).needsAttention).toBe(true);
    const texts = (
      (stored(store, id).comments ?? []) as Array<{ text: string }>
    ).map((c) => c.text);
    expect(texts.some((t) => t.includes("blocked on API response shape"))).toBe(
      true,
    );
  });

  it("--set-attention WITHOUT --comment fails non-zero and leaves the flag unset", async () => {
    const store = freshDir("set-attention-");
    const home = freshDir("set-attention-home-");
    const id = await addTask(store, home, "No reason given");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-attention", "--json"],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    // Refusals ride stderr as {ok:false, error:{code,...}} (tasks-json-refusals).
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_USAGE");
    expect(stored(store, id).needsAttention).toBeUndefined();
    expect("needsAttention" in stored(store, id)).toBe(false);
  });

  it("--set-attention and --clear-attention together are refused", async () => {
    const store = freshDir("set-attention-");
    const home = freshDir("set-attention-home-");
    const id = await addTask(store, home, "Contradiction");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-attention",
        "--clear-attention",
        "--comment",
        "reason",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_USAGE");
    expect(stored(store, id).needsAttention).toBeUndefined();
  });

  it("--clear-attention clears a flagged task with no comment", async () => {
    const store = freshDir("set-attention-");
    const home = freshDir("set-attention-home-");
    const id = await addTask(store, home, "Flag then clear");
    const set = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-attention",
        "--comment",
        "needs eyes",
        "--json",
      ],
      { cwd: store, home },
    );
    expect(set.code).toBe(0);
    expect(stored(store, id).needsAttention).toBe(true);

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--clear-attention", "--json"],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(stored(store, id).needsAttention).toBe(false);
  });
});
