/**
 * CLI e2e — task `author` attribution.
 *
 * `tasks --add` and `tasks --edit --set-status` must stamp the task-store
 * repo's git identity so an agent-created task matches a human-created one.
 * Identity is resolved from the project dir, not the process cwd.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { spawnCli } from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedGitUser(projectDir: string, name: string, email: string): void {
  execSync(
    `git init && git config user.name '${name}' && git config user.email '${email}'`,
    { cwd: projectDir, stdio: "ignore" },
  );
}

function taskFile(projectDir: string, taskId: string): string {
  const tasksDir = join(projectDir, ".vibeflow", "tasks");
  for (const entry of readdirSync(tasksDir)) {
    const candidate = join(tasksDir, entry, `${taskId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`task file not found for ${taskId}`);
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks author attribution", () => {
  it("--add stamps the task-store git identity", async () => {
    const store = freshDir("author-store-");
    const home = freshDir("author-home-");
    seedGitUser(store, "Store User", "store@example.com");

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Created by agent", "--json"],
      { cwd: store, home },
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.task.author).toBe("Store User");
  });

  it("--edit --set-status in-progress stamps the author on transition", async () => {
    const store = freshDir("author-store-");
    const home = freshDir("author-home-");
    seedGitUser(store, "Store User", "store@example.com");

    const add = await spawnCli(
      ["tasks", store, "--add", "--title", "Claim me", "--json"],
      { cwd: store, home },
    );
    const id = JSON.parse(add.stdout).task.id;

    // Simulate a task that predates author stamping.
    const file = taskFile(store, id);
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    delete raw.author;
    writeFileSync(file, JSON.stringify(raw, null, 2));

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-status", "in-progress", "--json"],
      { cwd: store, home },
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.task.status).toBe("in-progress");
    expect(parsed.task.author).toBe("Store User");
  });

  it("resolves identity from the store dir even when cwd is a different repo", async () => {
    const store = freshDir("author-store-");
    const elsewhere = freshDir("author-cwd-");
    const home = freshDir("author-home-");
    seedGitUser(store, "Store User", "store@example.com");
    seedGitUser(elsewhere, "Cwd User", "cwd@example.com");

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Wrong cwd?", "--json"],
      { cwd: elsewhere, home },
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.task.author).toBe("Store User");
  });
});
