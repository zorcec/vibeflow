import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addComment } from "../../src/core/comments.js";

// A comment created through the CLI carries the project repo's git
// user.email as `authorEmail` — the local-record side of lossless
// attribution. `author` stays the actor text; agent comments and
// web-originated comments never get an email.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

describe("comment authorEmail capture", () => {
  let projectDir: string;

  const writeTask = (): void => {
    const dateDir = join(projectDir, ".vibeflow", "tasks", "2025-01-01");
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(
      join(dateDir, "task-1.json"),
      JSON.stringify(
        {
          id: "task-1",
          title: "T",
          description: "",
          status: "todo",
          selector: "/",
          created: "2025-01-01T00:00:00.000Z",
        },
        null,
        2,
      ),
      "utf-8",
    );
  };

  const storedComments = (): Array<Record<string, unknown>> => {
    const raw = JSON.parse(
      readFileSync(join(projectDir, ".vibeflow", "tasks", "2025-01-01", "task-1.json"), "utf-8"),
    ) as { comments?: Array<Record<string, unknown>> };
    return raw.comments ?? [];
  };

  const initRepoWithEmail = (email: string | null): void => {
    git(projectDir, "init");
    if (email !== null) git(projectDir, "config", "user.email", email);
    git(projectDir, "config", "user.name", "Test User");
  };

  const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };

  beforeEach(() => {
    // Hermetic: without this, a developer machine's global user.email leaks
    // into "repo has no user.email" cases and the test asserts the wrong
    // environment. /dev/null makes git see no global/system config at all.
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    projectDir = mkdtempSync(join(tmpdir(), "comment-email-"));
    writeTask();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
    if (savedEnv.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = savedEnv.system;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("sets authorEmail on a human CLI comment from git config user.email, keeping author text", async () => {
    initRepoWithEmail("cli-author@example.com");
    const comment = await addComment(projectDir, "task-1", "user", "hello");
    expect(comment.author).toBe("user");
    expect(comment.authorEmail).toBe("cli-author@example.com");
    const [stored] = storedComments();
    expect(stored.author).toBe("user");
    expect(stored.authorEmail).toBe("cli-author@example.com");
  });

  it("never sets authorEmail on agent-authored comments", async () => {
    initRepoWithEmail("cli-author@example.com");
    const comment = await addComment(projectDir, "task-1", "agent", "shipped");
    expect(comment.author).toBe("agent");
    expect("authorEmail" in comment).toBe(false);
    const [stored] = storedComments();
    expect("authorEmail" in stored).toBe(false);
  });

  it("never sets authorEmail on web-originated comments", async () => {
    initRepoWithEmail("cli-author@example.com");
    const comment = await addComment(
      projectDir,
      "task-1",
      "user",
      "from the browser",
      undefined,
      undefined,
      "web",
    );
    expect("authorEmail" in comment).toBe(false);
  });

  it("omits authorEmail (and does not write \"\") when git user.email is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    initRepoWithEmail(null);
    const comment = await addComment(projectDir, "task-1", "user", "no identity");
    expect("authorEmail" in comment).toBe(false);
    const [stored] = storedComments();
    expect("authorEmail" in stored).toBe(false);
    expect(JSON.stringify(stored)).not.toContain("authorEmail");
  });

  it("rejects a non-email git user.email the same way as a missing one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    initRepoWithEmail("not-an-email");
    const comment = await addComment(projectDir, "task-1", "user", "bad identity");
    expect("authorEmail" in comment).toBe(false);
  });

  it("warns only once per process when the email cannot be captured", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    initRepoWithEmail(null);
    // Fresh module instance so the warn-once latch starts unset regardless of
    // what earlier tests in this file already did.
    vi.resetModules();
    const { addComment: freshAddComment } = await import("../../src/core/comments.js");
    await freshAddComment(projectDir, "task-1", "user", "one");
    await freshAddComment(projectDir, "task-1", "user", "two");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("user.email");
  });
});
