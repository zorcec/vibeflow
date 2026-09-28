/**
 * MCP e2e — CLI hang regression (spec §2.9).
 *
 * Spawns the built CLI with NO server running (HOME-isolated, telemetry off)
 * and asserts each operation completes fast (well under the old 30s+ hang
 * threshold) and emits the expected output shape. Behaviors pinned live:
 *   --add --json  → {success:true, task:{...}}       (~0.5s)
 *   --next --json → {ok:true, task:null, next_actions:[]} on an empty board
 *   --json (list) → bare JSON array ([] when empty)
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, globSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCli } from "./mcp-helpers.js";

const createdDirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

const HANG_BUDGET_MS = 3000;

describe("MCP CLI hang regression", () => {
  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("1: tasks <tmp> --add --json without server → exit 0, <3s, parses", async () => {
    const dir = freshDir("mcp-hang-proj-");
    const r = await spawnCli(
      ["tasks", dir, "--add", "--title", "hang probe", "--json"],
      { cwd: dir, home: freshDir("mcp-hang-home-"), timeoutMs: HANG_BUDGET_MS },
    );
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeLessThan(HANG_BUDGET_MS);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.task.id).toMatch(/^[a-f0-9]+$/);
    // task exists on disk
    const matches = globSync(
      join(dir, ".vibeflow", "tasks", "**", `${parsed.task.id}.json`),
    );
    expect(matches.length).toBe(1);
  });

  it("2: --next --json on empty board → exit 0, <3s, {ok:true,task:null}", async () => {
    const dir = freshDir("mcp-hang-proj-");
    const r = await spawnCli(["tasks", dir, "--next", "--json"], {
      cwd: dir,
      home: freshDir("mcp-hang-home-"),
      timeoutMs: HANG_BUDGET_MS,
    });
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeLessThan(HANG_BUDGET_MS);
    // An empty board is a SUCCESS, so --json emits one JSON document and
    // nothing on stderr. `task: null` is the branch: no prose, no exit code.
    expect(r.stderr.trim()).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({ ok: true, task: null, next_actions: [] });
  });

  it("2b: --next --json with a filter that matches nothing → the same payload", async () => {
    const dir = freshDir("mcp-hang-proj-");
    await spawnCli(["tasks", dir, "--add", "--title", "a feature", "--json"], {
      cwd: dir,
      home: freshDir("mcp-hang-home-"),
      timeoutMs: HANG_BUDGET_MS,
    });
    // A valid filter that matches no task is the SAME situation as an empty
    // board, so it must not become a special case.
    const r = await spawnCli(
      ["tasks", dir, "--next", "--type", "Bug", "--json"],
      { cwd: dir, home: freshDir("mcp-hang-home-"), timeoutMs: HANG_BUDGET_MS },
    );
    expect(r.code).toBe(0);
    expect(r.stderr.trim()).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({ ok: true, task: null, next_actions: [] });
  });

  it("2c: --next in human mode on an empty board still prints the sentence, exit 0", async () => {
    const dir = freshDir("mcp-hang-proj-");
    const r = await spawnCli(["tasks", dir, "--next"], {
      cwd: dir,
      home: freshDir("mcp-hang-home-"),
      timeoutMs: HANG_BUDGET_MS,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No todo tasks found");
    expect(r.stdout).toContain("Nothing to work on.");
  });

  it("3: tasks <tmp> --json (list) without server → exit 0, <3s, parses as {ok:true,tasks:[]}", async () => {
    const dir = freshDir("mcp-hang-proj-");
    const r = await spawnCli(["tasks", dir, "--json"], {
      cwd: dir,
      home: freshDir("mcp-hang-home-"),
      timeoutMs: HANG_BUDGET_MS,
    });
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeLessThan(HANG_BUDGET_MS);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual({ ok: true, tasks: [], hiddenChildren: 0 });
  });
});
