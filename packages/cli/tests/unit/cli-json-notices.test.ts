/**
 * In-process coverage of the `--json` branches a spawned CLI cannot reach.
 *
 * Most of the `--json` contract is pinned by `tests/e2e/tasks-json-refusals.test.ts`,
 * which runs the built CLI as a child process. That is the right shape for
 * everything a real invocation can produce — but a write that FAILS needs a
 * failure the test can cause, and every filesystem condition that breaks the
 * comment write (`updateTask` → `writeTaskJson`) breaks the status write that
 * runs first, in the same process, on the same path. From outside the process
 * the two cannot be told apart. (A contended task lock does separate them —
 * `updateTask` gives up after 5s and writes anyway while `withTaskLock` throws
 * — but two 5s waits exceed the 10s stale threshold, so the second waiter
 * reclassifies the lock as stale forever and the CLI never returns.)
 *
 * So this file drives the commander tree in-process (`VIBEFLOW_CLI_SKIP_PARSE`
 * is the entry guard `src/index.ts` already provides for introspection) and
 * replaces `addComment` with a stub whose failure is under the test's control.
 * That is the only seam that isolates the reason-comment write from the status
 * write, and it is exactly the condition the branch under test turns on: the
 * write threw.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Command } from "commander";

/** Stub state, shared with the hoisted `vi.mock` factory below. */
const ctl = vi.hoisted(() => ({
  attempts: 0,
  /** Set to null to make the stub succeed; a string makes it throw that text. */
  failure: "Failed to acquire lock /tmp/.locks/verreason0000.lock within 5000ms",
}));

vi.mock("../../src/core/comments.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/core/comments.js")>();
  return {
    ...actual,
    addComment: async (
      projectDir: string,
      taskId: string,
      author: string,
      text: string,
    ) => {
      ctl.attempts++;
      if (ctl.failure !== null) throw new Error(ctl.failure);
      return {
        id: `stub-${ctl.attempts}`,
        taskId,
        author,
        text,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "comment" as const,
        source: "cli",
      };
    },
  };
});

const LOCK_ERROR = ctl.failure;

let createProgram: () => Command;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  process.env.VIBEFLOW_TELEMETRY = "0";
  // Entry guards in src/index.ts: import for the commander tree without
  // running a command or touching the network. Removed right after import —
  // the guards evaluate at import time.
  process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
  process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
  try {
    ({ createProgram } = await import("../../src/index.js"));
  } finally {
    delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
    delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
  }
});

type Captured = {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  logged: string[];
};

/**
 * Resolves once `size()` has stopped changing for a few ticks (the spawned
 * command is done writing), or after a hard cap so a runaway command fails the
 * assertion instead of hanging the suite.
 */
async function settle(size: () => number): Promise<void> {
  let last = -1;
  let quiet = 0;
  for (let tick = 0; tick < 250; tick++) {
    await new Promise((r) => setTimeout(r, 10));
    const now = size();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 3) return;
  }
}

/**
 * Runs one `tasks` invocation in-process, capturing both channels.
 *
 * `outputEnvelope` writes with `process.stdout.write`, so overriding it
 * captures the envelope. Human prose goes through `console.log`, which vitest
 * replaces with its own reporter — hence the separate `console.log` spy.
 */
async function runTasks(args: string[], home: string): Promise<Captured> {
  const previous = {
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
    exitCode: process.exitCode,
    home: process.env.HOME,
  };
  const logged: string[] = [];
  let stdout = "";
  let stderr = "";
  (process.stdout.write as unknown) = (chunk: string) => {
    stdout += chunk;
    return true;
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    stderr += chunk;
    return true;
  };
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    });
  process.exitCode = undefined;
  process.env.HOME = home;
  try {
    const program = createProgram();
    await program.parseAsync(["tasks", ...args], { from: "user" });
    // The `tasks` action is fire-and-forget (`void runTasksAndFlush()`), so
    // parseAsync resolves before the command has run. Wait for the captured
    // channels to go quiet rather than racing the work: a still-running
    // command would make the assertions below read a half-finished run.
    await settle(() => stdout.length + stderr.length + logged.length);
    return { stdout, stderr, exitCode: process.exitCode, logged };
  } finally {
    logSpy.mockRestore();
    (process.stdout.write as unknown) = previous.stdout;
    (process.stderr.write as unknown) = previous.stderr;
    process.exitCode = previous.exitCode;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
}

/** An isolated HOME (no token file ⇒ local mode) plus one todo task. */
function fixture(prefix: string): { store: string; home: string; id: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = join(base, "store");
  const home = join(base, "home");
  const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const id = "verreason0000";
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify(
      {
        id,
        title: "Verify reason target",
        description: "",
        status: "todo",
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
        comments: [],
        files: [],
        tags: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { store, home, id };
}

const VERIFY_ARGS = (id: string): string[] => [
  "--edit",
  id,
  "--set-verify",
  "cannot",
  "--verify-reason",
  "no badge renders on this page",
];

afterEach(() => {
  ctl.attempts = 0;
  ctl.failure = LOCK_ERROR;
  for (const fn of cleanups.splice(0)) fn();
});

describe("a lost --verify-reason is lost TASK DATA, not a warning", () => {
  it("emits E_COMMENT_SAVE on stderr and keeps stdout free of prose", async () => {
    const { store, home, id } = fixture("json-notices-");

    const r = await runTasks([store, ...VERIFY_ARGS(id), "--json"], home);

    // The write really was attempted — otherwise this test proves nothing.
    expect(ctl.attempts).toBe(1);

    expect(r.exitCode).not.toBe(0);
    expect(r.exitCode).not.toBeUndefined();
    // A refusal writes nothing to stdout, so there is nothing to mis-parse.
    expect(r.stdout.trim()).toBe("");

    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        suggestion?: string;
      };
    };
    expect(envelope.ok).toBe(false);
    // The SAME code as a lost --comment: one code, one meaning.
    expect(envelope.error.code).toBe("E_COMMENT_SAVE");
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.message).toContain("verify reason was NOT recorded");
    expect(envelope.error.message).toContain(LOCK_ERROR as string);
    // The suggestion must name the remedy, not just the failure.
    expect(envelope.error.suggestion).toContain("--set-verify cannot");
  });

  it("a saved reason still exits 0 with a success envelope", async () => {
    // The control: same invocation, comment write that WORKS. Without this the
    // test above could pass merely because the run refused for another reason.
    const { store, home, id } = fixture("json-notices-ok-");
    ctl.failure = null;

    const r = await runTasks([store, ...VERIFY_ARGS(id), "--json"], home);

    expect(ctl.attempts).toBe(1);
    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
    expect(r.stderr).not.toContain('"ok":false');
  });

  it("keeps the human-mode line, just without the --json envelope", async () => {
    const { store, home, id } = fixture("json-notices-human-");
    const r = await runTasks([store, ...VERIFY_ARGS(id)], home);
    expect(r.logged.join("\n")).toContain("Verify reason was NOT recorded");
    expect(r.exitCode).not.toBe(0);
  });
});
