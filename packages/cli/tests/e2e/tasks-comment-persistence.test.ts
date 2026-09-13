/**
 * CLI e2e — `--comment` persistence.
 *
 * The comment path used to be gated on `--set-status review`, so a comment on
 * any other transition was ACCEPTED and then silently discarded, while the CLI
 * printed `comment: added` unconditionally and before the write resolved. An
 * agent adding a note to a todo ticket lost it with no warning.
 *
 * These tests assert against the stored task JSON, not the CLI's stdout — the
 * stdout was exactly what lied.
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
import { spawnCli, seedGitUser } from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];

function freshStore(): { store: string; home: string } {
  const store = mkdtempSync(join(tmpdir(), "vibeflow-comment-"));
  const home = mkdtempSync(join(tmpdir(), "vibeflow-comment-home-"));
  cleanups.push(() => rmSync(store, { recursive: true, force: true }));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return { store, home };
}

function taskFile(projectDir: string, taskId: string): string {
  const tasksDir = join(projectDir, ".vibeflow", "tasks");
  for (const entry of readdirSync(tasksDir)) {
    const candidate = join(tasksDir, entry, `${taskId}.json`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`task file not found for ${taskId}`);
}

/** Comment text across both field names the store has used. */
function commentTexts(projectDir: string, taskId: string): string[] {
  const raw = JSON.parse(readFileSync(taskFile(projectDir, taskId), "utf-8"));
  const comments = (raw.comments ?? []) as Array<{
    text?: string;
    body?: string;
  }>;
  return comments.map((c) => c.text ?? c.body ?? "");
}

async function createTask(
  store: string,
  home: string,
  title: string,
): Promise<string> {
  const res = await spawnCli(
    ["tasks", store, "--add", "--title", title, "--type", "Bug", "--json"],
    { cwd: store, home },
  );
  return JSON.parse(res.stdout).task.id as string;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("tasks --edit --comment persistence", () => {
  it("keeps a comment on a non-review status (was silently dropped)", async () => {
    const { store, home } = freshStore();
    seedGitUser(store);
    const id = await createTask(store, home, "comment on todo");

    const res = await spawnCli(
      [
        "tasks", store, "--edit", id,
        "--set-status", "todo", "--comment", "NOTE-ON-TODO",
      ],
      { cwd: store, home },
    );

    // The comment must actually be stored — pre-fix the CLI printed
    // "comment: added" for a non-review status and stored nothing.
    expect(res.code).toBe(0);
    expect(commentTexts(store, id)).toContain("NOTE-ON-TODO");
  });

  it("keeps a comment when no status change is requested at all", async () => {
    const { store, home } = freshStore();
    seedGitUser(store);
    const id = await createTask(store, home, "comment only");

    const res = await spawnCli(
      ["tasks", store, "--edit", id, "--comment", "NOTE-NO-STATUS"],
      { cwd: store, home },
    );

    // Pre-fix this omitted --comment from `hasEdits`, so it printed the
    // browse/help block, exited 0 and wrote nothing.
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain("LLM Usage Instructions");
    expect(commentTexts(store, id)).toContain("NOTE-NO-STATUS");
  });

  it("keeps a comment on a backlog and an in-progress transition", async () => {
    const { store, home } = freshStore();
    seedGitUser(store);
    const id = await createTask(store, home, "comment on statuses");

    await spawnCli(
      [
        "tasks", store, "--edit", id,
        "--set-status", "backlog", "--comment", "NOTE-BACKLOG",
      ],
      { cwd: store, home },
    );
    await spawnCli(
      [
        "tasks", store, "--edit", id,
        "--set-status", "in-progress", "--comment", "NOTE-INPROGRESS",
      ],
      { cwd: store, home },
    );

    const texts = commentTexts(store, id);
    expect(texts).toContain("NOTE-BACKLOG");
    expect(texts).toContain("NOTE-INPROGRESS");
  });

  it("still stores the comment on a review transition", async () => {
    const { store, home } = freshStore();
    seedGitUser(store);
    const id = await createTask(store, home, "comment on review");

    const res = await spawnCli(
      [
        "tasks", store, "--edit", id,
        "--set-status", "review", "--comment", "NOTE-REVIEW",
        "--commit-message", "test: review",
      ],
      { cwd: store, home },
    );

    expect(res.code).toBe(0);
    expect(commentTexts(store, id)).toContain("NOTE-REVIEW");
  });
});
