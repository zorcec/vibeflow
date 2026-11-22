/**
 * `vibeflow notifications` end to end (ticket ae96cee7, parent 4e4feca1).
 *
 * Every assertion goes through the BUILT CLI in a temp project, so the flags,
 * the renderers and the `nextTs` cursor contract are exercised the way an agent
 * calls them. The event store itself is C1's (`.vibeflow/notifications.jsonl`):
 * these tests never write it by hand — `tasks --add`/`--edit` produce the
 * events, which is the only writer that matters.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCliIsolated } from "./spawn-isolated.js";
// Module-anchored CLI entry + isolated env (ticket 8ac96ef9) — the long-lived
// `--follow` spawn cannot use spawnCliIsolated (which resolves on exit), so it
// builds the same env through the chokepoint directly.
import { CLI_ENTRY, isolatedCliEnv } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";

/** The unit setup pins `VIBEFLOW_EVENTS=0`; a spawned child opts back in. */
const EVENTS_ON = { VIBEFLOW_EVENTS: "1" };

let cliHome: string;
let projectDir: string;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "vf-notif-cli-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-notif-cli-proj-"));
  ensureTaskDirs(projectDir);
});

afterEach(() => {
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** Run the CLI in the temp project with the event log switched ON. */
async function runCli(args: string[]) {
  return spawnCliIsolated(args, {
    cwd: projectDir,
    home: cliHome,
    env: EVENTS_ON,
    timeoutMs: 30_000,
  });
}

describe("vibeflow notifications (e2e)", () => {
  it("reports the create event of a `tasks --add` with a nextTs cursor", async () => {
    const add = await runCli(["tasks", "--add", "--title", "Notification feed"]);
    expect(add.code, `stderr: ${add.stderr}`).toBe(0);

    const run = await runCli(["notifications", "--json", "--local"]);
    expect(run.code, `stderr: ${run.stderr}`).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      ok: boolean;
      target: string;
      notifications: Array<{ type: string; taskId: string }>;
      nextTs: string | null;
      earliestTs: string | null;
      gap: boolean;
      truncated: boolean;
      count: number;
    };
    expect(payload.ok).toBe(true);
    expect(payload.target).toBe("local");
    expect(payload.notifications.map((e) => e.type)).toContain("task.create");
    expect(payload.nextTs).toBeTruthy();
    expect(payload.earliestTs).toBeTruthy();
    expect(payload.count).toBe(payload.notifications.length);
    expect(payload.gap).toBe(false);
  });

  it("returns nothing new when the previous nextTs is passed back as --since", async () => {
    const add = await runCli(["tasks", "--add", "--title", "Cursor round trip"]);
    expect(add.code, `stderr: ${add.stderr}`).toBe(0);
    const first = await runCli(["notifications", "--json", "--local"]);
    const { nextTs } = JSON.parse(first.stdout) as { nextTs: string };

    const second = await runCli([
      "notifications",
      "--json",
      "--local",
      "--since",
      nextTs,
    ]);
    expect(second.code, `stderr: ${second.stderr}`).toBe(0);
    const payload = JSON.parse(second.stdout) as {
      notifications: Array<{ ts: string }>;
      count: number;
      nextTs: string;
    };
    // `since` is INCLUSIVE by design (at-least-once): the boundary event may
    // repeat, never disappear. Nothing was written after the cursor, so "no
    // news" is asserted as "nothing NEWER than the cursor" — not as an empty
    // page, which would require the read to silently drop a boundary event.
    expect(payload.notifications.every((e) => e.ts === nextTs)).toBe(true);
    expect(payload.notifications.filter((e) => e.ts > nextTs)).toEqual([]);
    expect(payload.nextTs).toBe(nextTs);
    expect(payload.count).toBe(payload.notifications.length);
  });

  it("prints one line per event and a final `nextTs:` line for a human", async () => {
    const add = await runCli(["tasks", "--add", "--title", "Human feed"]);
    expect(add.code, `stderr: ${add.stderr}`).toBe(0);

    const run = await runCli(["notifications", "--local"]);
    expect(run.code, `stderr: ${run.stderr}`).toBe(0);
    const lines = run.stdout.split("\n").filter((l) => l !== "");
    expect(lines.some((l) => l.includes("task.create"))).toBe(true);
    const cursor = lines.find((l) => l.startsWith("nextTs: "));
    expect(cursor).toBeTruthy();
    expect(cursor!.slice("nextTs: ".length)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("follows with --exec: one NDJSON line per new event, clean exit on SIGINT", async () => {
    const children: ChildProcess[] = [];
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "notifications", "--follow", "--local", "--exec", "cat"],
      {
        cwd: projectDir,
        env: isolatedCliEnv({ home: cliHome, cwd: projectDir, env: EVENTS_ON }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => (stdout += d));
    child.stderr!.on("data", (d: string) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    try {
      // One mutation after the follower is already polling: its event must
      // arrive through the ONE long-lived child's stdout as a single JSON line.
      const edit = await runCli([
        "tasks",
        "--add",
        "--title",
        "Followed event",
      ]);
      expect(edit.code, `stderr: ${edit.stderr}`).toBe(0);

      const line = await new Promise<string>((resolve, reject) => {
        const deadline = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for a followed event; stdout:\n${stdout}\nstderr:\n${stderr}`,
              ),
            ),
          20_000,
        );
        const check = (): void => {
          const first = stdout
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.startsWith("{"));
          if (first !== undefined) {
            clearTimeout(deadline);
            resolve(first);
            return;
          }
          setTimeout(check, 100);
        };
        check();
      });
      const event = JSON.parse(line) as { type: string; taskId: string };
      expect(event.type).toBe("task.create");
      expect(event.taskId).toBeTruthy();

      child.kill("SIGINT");
      expect(await exited).toBe(0);
      // No stack trace leaked on the interrupt path.
      expect(stderr).not.toContain("at ");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
