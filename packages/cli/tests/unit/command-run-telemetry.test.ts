/**
 * `command_run` analytics properties (ticket ed5c70e2).
 *
 * Two instrumentation gaps were closed and are pinned here:
 *
 *  1. `tasks --edit` now carries `from_status` / `to_status` on its
 *     `command_run` event so the status funnel (created → in-progress →
 *     review → done) is queryable — previously only the subcommand string
 *     was captured and every mutation looked alike.
 *  2. `serve` now emits a `subcommand` (`api` = API-only task server,
 *     `prototype` = an HTML target was given) so the 600+ serve calls have
 *     a mode breakdown.
 *
 * The real telemetry module is mocked at the `capture()` seam (telemetry is
 * disabled under vitest anyway), and the commander tree is driven in-process
 * — the same harness shape as `cli-json-notices.test.ts`. The payload is
 * asserted with `toEqual` so any future property added to these events has to
 * be deliberate: the analytics contract here is "small and PII-free".
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Command } from "commander";

/** Spy shared with the hoisted `vi.mock` factory below. */
const captureSpy = vi.hoisted(() => vi.fn());

vi.mock("../../src/telemetry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/telemetry.js")>();
  return {
    ...actual,
    capture: captureSpy,
  };
});

/** `serve` must never bind a port from a unit test — the CLI action only
 *  needs the capture to fire before the server starts. */
const serveSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/server.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/server.js")>();
  return {
    ...actual,
    serve: serveSpy as unknown as typeof actual.serve,
  };
});

let createProgram: () => Command;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  process.env.VIBEFLOW_TELEMETRY = "0";
  // Entry guards in src/index.ts: import for the commander tree without
  // running a command or hitting the network. Removed right after import.
  process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
  process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
  try {
    ({ createProgram } = await import("../../src/index.js"));
  } finally {
    delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
    delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
  }
});

beforeEach(() => {
  captureSpy.mockClear();
  serveSpy.mockClear();
});

type Captured = {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
};

/** `command_run` payloads captured so far (each call is `[event, props]`). */
function commandRunProps(): Array<Record<string, unknown>> {
  return captureSpy.mock.calls
    .filter((call) => call[0] === "command_run")
    .map((call) => call[1] as Record<string, unknown>);
}

/** Waits until stdout/stderr/log lines and capture calls stop changing. */
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
 * Runs one command in-process, capturing both channels.
 *
 * The `tasks` action is fire-and-forget (`void runTasks()`), so parseAsync
 * resolves before the command has run — settle() waits for the channels to go
 * quiet. HOME is isolated so the edit path sees local mode, never a real
 * SaaS token.
 */
async function runCli(args: string[], home: string): Promise<Captured> {
  const previous = {
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
    exitCode: process.exitCode,
    home: process.env.HOME,
  };
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
    .mockImplementation(() => undefined);
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  process.exitCode = undefined;
  process.env.HOME = home;
  try {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
    await settle(
      () =>
        stdout.length +
        stderr.length +
        captureSpy.mock.calls.length +
        serveSpy.mock.calls.length,
    );
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    (process.stdout.write as unknown) = previous.stdout;
    (process.stderr.write as unknown) = previous.stderr;
    process.exitCode = previous.exitCode;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
}

/** An isolated HOME plus one `todo` task in a temp store. */
function fixture(prefix: string): { store: string; home: string; id: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = join(base, "store");
  const home = join(base, "home");
  const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const id = "analytics0000";
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify(
      {
        id,
        title: "Analytics target",
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

/** Reads the persisted status of the fixture task (the control: the edit ran). */
function storedStatus(store: string, id: string): string {
  const raw = readFileSync(
    join(store, ".vibeflow", "tasks", "2026-01-01", `${id}.json`),
    "utf-8",
  );
  return (JSON.parse(raw) as { status: string }).status;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks --edit command_run carries the status transition", () => {
  it("emits from_status/to_status for a real transition (todo → in-progress)", async () => {
    const { store, home, id } = fixture("analytics-claim-");

    await runCli(
      ["tasks", store, "--edit", id, "--set-status", "in-progress"],
      home,
    );

    // Control: the transition actually happened, so the telemetry matches
    // reality rather than just the requested flag.
    expect(storedStatus(store, id)).toBe("in-progress");

    const events = commandRunProps();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      command: "tasks",
      subcommand: "edit",
      from_status: "todo",
      to_status: "in-progress",
    });
  });

  it("carries the done transition with the same coarse pair", async () => {
    const { store, home, id } = fixture("analytics-done-");

    await runCli(["tasks", store, "--edit", id, "--set-status", "done"], home);

    expect(storedStatus(store, id)).toBe("done");
    expect(commandRunProps()[0]).toEqual({
      command: "tasks",
      subcommand: "edit",
      from_status: "todo",
      to_status: "done",
    });
  });

  it("carries the review transition through the review gate", async () => {
    const { store, home, id } = fixture("analytics-review-");

    await runCli(
      [
        "tasks",
        store,
        "--edit",
        id,
        "--set-status",
        "review",
        "--comment",
        "implemented",
        "--commit-message",
        "feat: review the analytics ticket",
      ],
      home,
    );

    expect(storedStatus(store, id)).toBe("review");
    expect(commandRunProps()[0]).toEqual({
      command: "tasks",
      subcommand: "edit",
      from_status: "todo",
      to_status: "review",
    });
  });

  it("pairs the statuses when the edit does not change status", async () => {
    const { store, home, id } = fixture("analytics-title-");

    await runCli(
      ["tasks", store, "--edit", id, "--title", "Retitled"],
      home,
    );

    // A content-only edit shows as a self-pair — present, queryable, no gap.
    expect(commandRunProps()[0]).toEqual({
      command: "tasks",
      subcommand: "edit",
      from_status: "todo",
      to_status: "todo",
    });
  });

  it("omits the pair when the target task cannot be resolved", async () => {
    const { store, home } = fixture("analytics-unknown-");

    await runCli(
      ["tasks", store, "--edit", "nope0000000000", "--set-status", "in-progress"],
      home,
    );

    // The event still fires (it fires for every invocation) but never
    // fabricates a transition for a task it could not read.
    const events = commandRunProps();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      command: "tasks",
      subcommand: "edit",
    });
    expect(events[0]).not.toHaveProperty("from_status");
    expect(events[0]).not.toHaveProperty("to_status");
  });

  it("keeps non-edit subcommands free of status properties", async () => {
    const { store, home, id } = fixture("analytics-get-");

    await runCli(["tasks", store, "--get", id], home);

    const events = commandRunProps();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      command: "tasks",
      subcommand: "get",
    });
    expect(events[0]).not.toHaveProperty("from_status");
    expect(events[0]).not.toHaveProperty("to_status");
  });
});

describe("serve command_run carries a mode breakdown", () => {
  it("emits subcommand 'api' when no target is given (API-only server)", async () => {
    const { store, home } = fixture("analytics-serve-api-");

    await runCli(["serve", "--project", store, "--no-open"], home);

    expect(commandRunProps()[0]).toEqual({
      command: "serve",
      subcommand: "api",
    });
    // The action reached the (mocked) server start.
    expect(serveSpy).toHaveBeenCalledTimes(1);
  });

  it("emits subcommand 'prototype' when an HTML target is given", async () => {
    const { home } = fixture("analytics-serve-proto-");

    await runCli(["serve", "protos/index.html", "--no-open"], home);

    expect(commandRunProps()[0]).toEqual({
      command: "serve",
      subcommand: "prototype",
    });
    expect(serveSpy).toHaveBeenCalledTimes(1);
  });
});
