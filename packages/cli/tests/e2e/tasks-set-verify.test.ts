/**
 * CLI e2e — the tri-state verification verdict flag `--set-verify` in isolation.
 *
 * `tasks --edit <id> --set-verify <verdict>` must write the verdict (or clear
 * for "cannot"), and the flag must never silently no-op — a verdict with no
 * other edit still counts as an edit. Review transitions covered here: pass →
 * allowed, fail → blocked, cannot+reason → allowed (reason recorded), omitted
 * on an annotated task → blocked with an error naming all three options, and
 * cannot without --verify-reason → rejected. Non-annotated tasks stay ungated.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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

function storedComments(projectDir: string, taskId: string): Array<{ text: string; type?: string }> {
  return (JSON.parse(readFileSync(taskFile(projectDir, taskId), "utf-8"))
    .comments ?? []) as Array<{ text: string; type?: string }>;
}

async function addTask(store: string, home: string, title: string): Promise<string> {
  const add = await spawnCli(
    ["tasks", store, "--add", "--title", title, "--json"],
    { cwd: store, home },
  );
  return JSON.parse(add.stdout).task.id;
}

/** Seed an annotated task (url + selector) directly. */
function seedAnnotatedTask(store: string, id: string): void {
  const tasksDir = join(store, ".vibeflow", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(join(tasksDir, "2025-01-01"), { recursive: true });
  writeFileSync(
    join(tasksDir, "2025-01-01", `${id}.json`),
    JSON.stringify(
      {
        id,
        title: "Annotated gate task",
        description: "",
        status: "in-progress",
        type: "Task",
        priority: "Medium",
        selector: ".submit-btn",
        cssSelector: ".submit-btn",
        url: "https://example.com",
        created: "2025-01-01T10:00:00.000Z",
      },
      null,
      2,
    ),
  );
}

/** Turn the verify gate ON for the store. */
function enableVerifyGate(store: string): void {
  const protoDir = join(store, ".vibeflow");
  mkdirSync(protoDir, { recursive: true });
  writeFileSync(
    join(protoDir, "settings.json"),
    JSON.stringify({
      autoCommit: false,
      autoComment: false,
      autoPush: false,
      createBranch: false,
      requireVerifyBeforeReview: true,
    }),
  );
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks --edit --set-verify", () => {
  it("--set-verify pass alone attests true (no silent no-op)", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Attest me");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "pass", "--json"],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(storedVerified(store, id)).toBe(true);
  });

  it("--set-verify fail alone records false (a completed negative verdict)", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Fail me");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "fail", "--json"],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    expect(storedVerified(store, id)).toBe(false);
  });

  it("--set-verify cannot + --verify-reason clears to absent and records the reason", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Unverifiable");
    await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "pass", "--json"],
      { cwd: store, home },
    );
    expect(storedVerified(store, id)).toBe(true);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-verify",
        "cannot",
        "--verify-reason",
        "no browser in this environment",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    // Absent — the key is dropped from the on-disk JSON, not `false`/`null`.
    expect(storedVerified(store, id)).toBeUndefined();
    expect(
      "verified" in JSON.parse(readFileSync(taskFile(store, id), "utf-8")),
    ).toBe(false);
    // The reason is recorded as a system activity item for the detail panel.
    const texts = storedComments(store, id).map((c) => c.text);
    expect(
      texts.some(
        (t) =>
          t.includes("Cannot verify") &&
          t.includes("no browser in this environment"),
      ),
    ).toBe(true);
  });

  it("--set-verify cannot WITHOUT --verify-reason is rejected and writes nothing", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Missing reason");

    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-verify", "cannot", "--json"],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("--verify-reason");
    // Nothing written — the store stays absent.
    expect(storedVerified(store, id)).toBeUndefined();
  });

  it("--verify-reason without --set-verify cannot is rejected", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    const id = await addTask(store, home, "Orphan reason");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-verify",
        "pass",
        "--verify-reason",
        "why?",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("--set-verify cannot");
  });

  it("omitting a verdict on an annotated task blocks review with an error naming all three options", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    enableVerifyGate(store);
    const id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    seedAnnotatedTask(store, id);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--comment",
        "done",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("--set-verify pass");
    expect(r.stdout).toContain("--set-verify fail");
    expect(r.stdout).toContain("--set-verify cannot");
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("in-progress");
  });

  it("--set-verify cannot + reason allows review of an annotated task", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    enableVerifyGate(store);
    const id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    seedAnnotatedTask(store, id);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--set-verify",
        "cannot",
        "--verify-reason",
        "behind corporate SSO",
        "--comment",
        "done",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("review");
    expect(onDisk.verified).toBeUndefined();
    const texts = (onDisk.comments ?? []).map((c: { text: string }) => c.text);
    expect(
      texts.some((t: string) => t.includes("behind corporate SSO")),
    ).toBe(true);
  });

  it("--set-verify fail blocks review of an annotated task", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    enableVerifyGate(store);
    const id = "cccccccccccccccccccccccccccccc";
    seedAnnotatedTask(store, id);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--set-verify",
        "fail",
        "--comment",
        "it is wrong",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("NOT implemented correctly");
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("in-progress");
    // The gate ran BEFORE any write — the negative verdict was never applied.
    expect(onDisk.verified).toBeUndefined();
  });

  it("non-annotated tasks stay ungated — review without a verdict is allowed", async () => {
    const store = freshDir("set-verify-");
    const home = freshDir("set-verify-home-");
    enableVerifyGate(store);
    // `tasks --add` creates non-annotated tasks (selector "/", no url).
    const id = await addTask(store, home, "No annotation");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--comment",
        "done",
        "--json",
      ],
      { cwd: store, home },
    );

    expect(r.code).toBe(0);
    const onDisk = JSON.parse(readFileSync(taskFile(store, id), "utf-8"));
    expect(onDisk.status).toBe("review");
    expect(onDisk.verified).toBeUndefined();
  });
});