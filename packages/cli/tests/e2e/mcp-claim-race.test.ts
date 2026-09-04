/**
 * MCP e2e — claim atomicity (spec §2.5, Phase 2 LANDED).
 *
 * Phase 2 shipped claimNextTaskAtomic (cross-process serialized claim with
 * re-check before write), so the [Phase 2] flip expectations are NOW active:
 *   - two spawned `tasks <tmp> --next --json` racers claim DIFFERENT tasks
 *   - two concurrent MCP claim_next_task calls claim DIFFERENT tasks
 *   - MCP claim sets author from the seeded git user
 *
 * Facts pinned live (dist build): `--next --json` prints
 * {success:true, task:{...}, next_actions:[...]}; empty board prints plain
 * text "No todo tasks found. Nothing to work on." (NOT JSON, exit 0).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  assertJsonTextContent,
  seedGitUser,
  seedTask,
  spawnCli,
  type McpTestEnv,
} from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-race-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-race-home-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function taskFile(projectDir: string, taskId: string): string {
  return join(projectDir, ".vibeflow", "tasks", `${taskId}.json`);
}

describe("MCP claim atomicity", () => {
  it("1: two spawned CLI racers → different ids, one in-progress each, author set", async () => {
    const dir = freshProject();
    seedGitUser(dir);
    seedTask(dir, {
      id: "r1000000000000000000000000000aa",
      title: "racer A",
      status: "todo",
      priority: "High",
    });
    seedTask(dir, {
      id: "r2000000000000000000000000000bb",
      title: "racer B",
      status: "todo",
      priority: "Low",
    });

    const home = freshHome();
    const [r1, r2] = await Promise.all([
      spawnCli(["tasks", dir, "--next", "--json"], { cwd: dir, home }),
      spawnCli(["tasks", dir, "--next", "--json"], { cwd: dir, home }),
    ]);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    const p1 = JSON.parse(r1.stdout);
    const p2 = JSON.parse(r2.stdout);
    expect(p1.success).toBe(true);
    expect(p2.success).toBe(true);
    // Phase 2: atomic claim — racers get disjoint tasks
    expect(p1.task.id).not.toBe(p2.task.id);
    expect(new Set([p1.task.id, p2.task.id])).toEqual(
      new Set(["r1000000000000000000000000000aa", "r2000000000000000000000000000bb"]),
    );
    // exactly one in-progress per racer; both tasks claimed overall
    for (const parsed of [p1, p2]) {
      expect(parsed.task.status).toBe("in-progress");
    }
    const a = JSON.parse(readFileSync(taskFile(dir, p1.task.id), "utf-8"));
    const b = JSON.parse(readFileSync(taskFile(dir, p2.task.id), "utf-8"));
    expect(a.status).toBe("in-progress");
    expect(b.status).toBe("in-progress");
    // author seeded from git user
    expect(a.author || b.author).toBeTruthy();
  });

  it("2: two concurrent MCP claim_next_task → different ids, in-progress on disk", async () => {
    const dir = freshProject();
    seedGitUser(dir); // BEFORE boot — MCP reads git user at server creation
    seedTask(dir, {
      id: "m1000000000000000000000000000aa",
      title: "mcp racer A",
      status: "todo",
      priority: "High",
    });
    seedTask(dir, {
      id: "m2000000000000000000000000000bb",
      title: "mcp racer B",
      status: "todo",
      priority: "Low",
    });
    const env: McpTestEnv = await bootMcpServer(dir);
    try {
      const client = newClient(env.mcpUrl);
      await initialize(client);
      const [res1, res2] = await Promise.all([
        callTool(client, "claim_next_task", { dryRun: false }),
        callTool(client, "claim_next_task", { dryRun: false }),
      ]);
      const c1 = await assertJsonTextContent(res1);
      const c2 = await assertJsonTextContent(res2);
      // Phase 2: find-then-update race is gone
      expect(c1.id).not.toBe(c2.id);
      expect(c1.author).toBe("E2E User");
      expect(c2.author).toBe("E2E User");
      const onDisk1 = JSON.parse(readFileSync(taskFile(dir, c1.id), "utf-8"));
      const onDisk2 = JSON.parse(readFileSync(taskFile(dir, c2.id), "utf-8"));
      expect(onDisk1.status).toBe("in-progress");
      expect(onDisk2.status).toBe("in-progress");
    } finally {
      await env.cleanup();
    }
  });

  it("3: single --next on empty board → non-JSON stdout, exit 0", async () => {
    const dir = freshProject();
    seedGitUser(dir);
    const r = await spawnCli(["tasks", dir, "--next", "--json"], {
      cwd: dir,
      home: freshHome(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().startsWith("{")).toBe(false);
    expect(r.stdout).toContain("No todo tasks found");
  });

  it("4: MCP claim author is the seeded git user", async () => {
    const dir = freshProject();
    seedGitUser(dir);
    seedTask(dir, {
      id: "m3000000000000000000000000000cc",
      title: "author probe",
      status: "todo",
    });
    const env: McpTestEnv = await bootMcpServer(dir);
    try {
      const client = newClient(env.mcpUrl);
      await initialize(client);
      const claimed = await assertJsonTextContent(
        await callTool(client, "claim_next_task", { dryRun: false }),
      );
      expect(claimed.author).toBe("E2E User");
      const onDisk = JSON.parse(readFileSync(taskFile(dir, claimed.id), "utf-8"));
      expect(onDisk.author).toBe("E2E User");
      expect(existsSync(taskFile(dir, claimed.id))).toBe(true);
    } finally {
      await env.cleanup();
    }
  });
});
