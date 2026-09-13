/**
 * CLI e2e — the verify attestation flags in isolation.
 *
 * `tasks --edit <id> --verified` used to omit the attestation flags from the
 * `hasEdits` guard, so with no other edit it fell through to the browse/help
 * output and exited 0 while writing NOTHING — a silent no-op an agent would
 * misread as a successful attestation. These tests run the flags alone and
 * assert the store actually changed, so the no-op cannot come back.
 *
 * The clearing flag, `--unset-verified`, must write ABSENCE (the key is dropped)
 * — distinct from `--verify-failed`, which writes `false` (verified as WRONG).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
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

function storedVerified(projectDir: string, taskId: string): unknown {
  return JSON.parse(readFileSync(taskFile(projectDir, taskId), "utf-8"))
    .verified;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks --edit verify attestation flags", () => {
  it("--verified alone attests true (no silent no-op)", async () => {
    const store = freshDir("verify-flag-");
    const home = freshDir("verify-flag-home-");

    const add = await spawnCli(
      ["tasks", store, "--add", "--title", "Attest me", "--json"],
      { cwd: store, home },
    );
    const id = JSON.parse(add.stdout).task.id;

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--verified", "--json"],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(storedVerified(store, id)).toBe(true);
  });

  it("--verify-failed alone records false (a completed negative verdict)", async () => {
    const store = freshDir("verify-flag-");
    const home = freshDir("verify-flag-home-");

    const add = await spawnCli(
      ["tasks", store, "--add", "--title", "Fail me", "--json"],
      { cwd: store, home },
    );
    const id = JSON.parse(add.stdout).task.id;

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--verify-failed", "--json"],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(storedVerified(store, id)).toBe(false);
  });

  it("--unset-verified alone clears a stored verdict to absent", async () => {
    const store = freshDir("verify-flag-");
    const home = freshDir("verify-flag-home-");

    const add = await spawnCli(
      ["tasks", store, "--add", "--title", "Unverifiable", "--json"],
      { cwd: store, home },
    );
    const id = JSON.parse(add.stdout).task.id;

    await spawnCli(["tasks", store, "--edit", id, "--verified", "--json"], {
      cwd: store,
      home,
    });
    expect(storedVerified(store, id)).toBe(true);

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--unset-verified", "--json"],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(storedVerified(store, id)).toBeUndefined();
    // The key is dropped from the on-disk JSON — absent, not `false`/`null`.
    expect(
      "verified" in
        JSON.parse(readFileSync(taskFile(store, id), "utf-8")),
    ).toBe(false);
  });

  it("--unset-verified cannot be combined with --verified (explicit error)", async () => {
    const store = freshDir("verify-flag-");
    const home = freshDir("verify-flag-home-");

    const add = await spawnCli(
      ["tasks", store, "--add", "--title", "Contradiction", "--json"],
      { cwd: store, home },
    );
    const id = JSON.parse(add.stdout).task.id;

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--verified",
        "--unset-verified",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("--unset-verified");
    // Nothing written — the store stays absent.
    expect(storedVerified(store, id)).toBeUndefined();
  });
});
