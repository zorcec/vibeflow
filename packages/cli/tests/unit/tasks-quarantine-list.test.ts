/**
 * Quarantine warnings for `tasks` list (ticket 74d9c46f).
 *
 * A fixture store with one quarantined record warns exactly ONCE per run —
 * the count and the first reason, never one line per file — and the warning
 * survives `--json` in the envelope. A clean store stays silent. The exit
 * code is unchanged (a warning is not a failure).
 *
 * Drives the commander tree in-process (same harness as
 * cli-json-notices.test.ts): `tasks` is fire-and-forget, so the capture
 * waits for the channels to go quiet.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Command } from "commander";

let createProgram: () => Command;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  process.env.VIBEFLOW_TELEMETRY = "0";
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

async function settle(size: () => number): Promise<void> {
  for (let tick = 0; tick < 50; tick++) {
    await new Promise((r) => setTimeout(r, 10));
    if (size() > 0) break;
  }
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

function cleanRecord(id: string): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
  };
}

/** An isolated HOME (no token ⇒ local mode) plus a store with clean + bad records. */
function fixture(prefix: string, badIds: string[]): { store: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = join(base, "store");
  const home = join(base, "home");
  const dir = join(store, ".vibeflow", "tasks", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(dir, "clean.json"), JSON.stringify(cleanRecord("cleantask")), "utf-8");
  for (const id of badIds) {
    // An unknown key is deliberate data this reader cannot express: the
    // record quarantines instead of being repaired (pinned by
    // tasks-record-conformance.test.ts).
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ ...cleanRecord(id), unknownData: "deliberate" }),
      "utf-8",
    );
  }
  return { store, home };
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function quarantineWarnings(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.includes("task record(s) quarantined"));
}

describe("list warns once about quarantined records", () => {
  it("human mode: one stderr warning with the count and the first reason, exit 0", async () => {
    const { store, home } = fixture("qwarn-list-", ["badtask"]);
    // NOTE: console.error bypasses an overridden process.stderr.write under
    // vitest, so the warning is observed with a console spy, not the channel
    // capture (proven by a debug run: 1 call, empty write-capture).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runTasks([store, "--status", "todo"], home);
    const warnings = quarantineWarnings(errSpy);
    errSpy.mockRestore();

    expect(r.exitCode ?? 0).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 task record(s) quarantined");
    expect(warnings[0]).toContain("badtask");
    expect(warnings[0]).toContain("unknownData");
    // The clean task still lists.
    expect(r.logged.join("\n")).toContain("cleantask");
  });

  it("--json: the envelope carries the same single warning, exit 0", async () => {
    const { store, home } = fixture("qwarn-list-json-", ["badtask"]);
    const r = await runTasks([store, "--status", "todo", "--json"], home);

    expect(r.exitCode ?? 0).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      notices?: Array<{ code: string; message: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.notices).toHaveLength(1);
    expect(payload.notices?.[0]?.code).toBe("TASK_RECORD_QUARANTINED");
    expect(payload.notices?.[0]?.message).toContain("1 task record(s) quarantined");
    expect(payload.notices?.[0]?.message).toContain("badtask");
    expect(payload.notices?.[0]?.message).toContain("unknownData");
  });

  it("three quarantined records still warn exactly once, with the count", async () => {
    const { store, home } = fixture("qwarn-list-multi-", ["bad1", "bad2", "bad3"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runTasks([store, "--status", "todo"], home);
    const warnings = quarantineWarnings(errSpy);
    errSpy.mockRestore();

    expect(r.exitCode ?? 0).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("3 task record(s) quarantined");
  });

  it("a clean store stays silent in both modes", async () => {
    const { store, home } = fixture("qwarn-list-clean-", []);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const human = await runTasks([store, "--status", "todo"], home);
    expect(human.exitCode ?? 0).toBe(0);
    expect(quarantineWarnings(errSpy)).toHaveLength(0);

    const json = await runTasks([store, "--status", "todo", "--json"], home);
    expect(json.exitCode ?? 0).toBe(0);
    expect(quarantineWarnings(errSpy)).toHaveLength(0);
    errSpy.mockRestore();
    const payload = JSON.parse(json.stdout) as { ok: boolean; notices?: unknown };
    expect(payload.ok).toBe(true);
    expect("notices" in payload).toBe(false);
  });
});
