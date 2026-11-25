/**
 * A follower must not be woken by its OWN write (ticket kzxaq0fd).
 *
 * `tasks --edit` appends an event stamped with the agent that caused it
 * (`$VIBEFLOW_ACTOR`). Without a delivery filter the pi extension starts a
 * turn to be told what it just did — the most expensive way to learn nothing.
 * The fix is identity-scoped: suppress an event only when its `agent` equals
 * THIS follower's explicitly set `$VIBEFLOW_ACTOR`.
 *
 * Proven here with the REAL board and two REAL `notifications --follow --json`
 * processes on the same feed:
 *   - agent A (`pi-a`) edits → A prints NOTHING, B (`pi-b`) prints it;
 *   - no `$VIBEFLOW_ACTOR` → BOTH print it (the documented residual: silence
 *     must never come from an unknown identity);
 *   - a delivered peer event still carries `agent`, so a consumer can decide.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWithPort } from "../helpers/serve-with-port.js";
import { CLI_ENTRY, isolatedCliEnv, spawnCliIsolated } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";
import type { ServeInstance } from "../../src/server/server.js";
import type { NotificationReadResult } from "../../src/core/notifications.js";

let cliHome: string;
let projectDir: string;
let instance: ServeInstance | null = null;
const followers: ChildProcess[] = [];
let outA = "";
let outB = "";
const savedEvents = process.env.VIBEFLOW_EVENTS;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "vf-selfsup-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-selfsup-proj-"));
  ensureTaskDirs(projectDir);
  outA = "";
  outB = "";
  process.env.VIBEFLOW_EVENTS = "1";
});

afterEach(async () => {
  for (const child of followers.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (instance) {
    await instance.close();
    instance = null;
  }
  if (savedEvents === undefined) delete process.env.VIBEFLOW_EVENTS;
  else process.env.VIBEFLOW_EVENTS = savedEvents;
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

async function readFeed(): Promise<NotificationReadResult> {
  const res = await fetch(`${instance!.url}/api/notifications?limit=200`);
  expect(res.status).toBe(200);
  return (await res.json()) as NotificationReadResult;
}

async function waitForBothFollowers(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${instance!.url}/api/notifications/subscribers`);
    const snapshot = (await res.json()) as { total: number };
    if (snapshot.total === 2) return;
    if (Date.now() > deadline) {
      throw new Error(
        `followers never registered (total ${snapshot.total})\nA:${outA}\nB:${outB}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}\nA:${outA}\nB:${outB}`);
}

/** Give a suppressed follower at least one full poll past the delivery. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 2_500));
}

function startFollower(
  agent: string,
  since: string,
  onOut: (chunk: string) => void,
): void {
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      "notifications",
      "--follow",
      "--local",
      "--json",
      "--since",
      since,
    ],
    {
      cwd: projectDir,
      env: isolatedCliEnv({
        home: cliHome,
        cwd: projectDir,
        // The empty string is the explicit "no identity" case: the CLI must
        // not inherit the test runner's environment into the child.
        env: { VIBEFLOW_EVENTS: "1", VIBEFLOW_ACTOR: agent },
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", onOut);
  followers.push(child);
}

async function runCli(args: string[], env: Record<string, string>): Promise<void> {
  const run = await spawnCliIsolated(args, {
    cwd: projectDir,
    home: cliHome,
    env: { VIBEFLOW_EVENTS: "1", ...env },
  });
  expect(run.code, `stderr: ${run.stderr}`).toBe(0);
}

async function createBoardTask(): Promise<string> {
  const res = await fetch(`${instance!.url}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "self suppression", selector: "#s" }),
  });
  const body = (await res.json()) as { task: { id: string } };
  return body.task.id;
}

describe("notifications --follow self-suppression (e2e, local board)", () => {
  it("A's edit reaches B but not A; without an identity both receive it", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      // @internal test hooks — force OFFLINE mode deterministically.
      _testToken: null,
      _testWorkspace: null,
    });
    const taskId = await createBoardTask();
    // Only events after this point matter: both followers start here.
    const since = new Date(Date.now() - 1_000).toISOString();
    startFollower("pi-a", since, (chunk) => (outA += chunk));
    startFollower("pi-b", since, (chunk) => (outB += chunk));
    await waitForBothFollowers();

    // ── A's own write ────────────────────────────────────────────────────
    await runCli(
      ["tasks", "--edit", taskId, "--set-status", "in-progress", "--json"],
      { VIBEFLOW_ACTOR: "pi-a" },
    );

    await until(
      () => outB.includes('"type":"task.update"'),
      "B to receive A's event",
    );
    await settle();
    // A's filter suppressed its own event; nothing else happened.
    expect(outA).toBe("");

    // The event is still in the feed (someone else can read it) and names the
    // writer — the payload a consumer decides from.
    const feed = await readFeed();
    expect(feed.count).toBe(1);
    expect(feed.notifications[0]).toMatchObject({
      type: "task.update",
      taskId,
      actor: "pi-a",
      agent: "pi-a",
    });
    expect(outB).toContain('"agent":"pi-a"');

    // ── no identity: the documented residual ─────────────────────────────
    await runCli(["tasks", "--edit", taskId, "--title", "renamed", "--json"], {
      VIBEFLOW_ACTOR: "",
    });
    await until(
      () => outA.includes('"changed":["title"]') && outB.includes('"changed":["title"]'),
      "both followers to receive the unidentified event",
    );
    const after = await readFeed();
    const unidentified = after.notifications.find(
      (event) => event.type === "task.update" && event.changed?.includes("title"),
    );
    expect(unidentified).toBeDefined();
    // No explicit identity → no `agent` → nobody can call it "own".
    expect(unidentified).not.toHaveProperty("agent");
  }, 90_000);
});
