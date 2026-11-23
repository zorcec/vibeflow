/**
 * Watching-badge contract on the local board (ticket cgor65lmpv31cib1ef9zce5m).
 *
 * Boots the real board in offline mode and spawns the BUILT `vibeflow
 * notifications --follow --local`, which is the producer the badge exists
 * for. Pins the whole promise:
 *   - the three local routes answer the 1:1 body shape;
 *   - a real follower registers and reports its `$VIBEFLOW_ACTOR` agent name;
 *   - SIGINT exits 0 and UNREGISTERS, so the badge drops to 0 without waiting
 *     for the 90 s TTL (no ghost).
 *
 * The heartbeat cadence is a unit-level contract (`SUBSCRIBER_HEARTBEAT_MS`);
 * waiting 30 s here would buy nothing but flake.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWithPort } from "../helpers/serve-with-port.js";
import { CLI_ENTRY, isolatedCliEnv } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";
import { writeConfig } from "../../src/core/config.js";
import type { ServeInstance } from "../../src/server/server.js";
import type { SubscriberSnapshot } from "../../src/core/subscribers.js";

let cliHome: string;
let projectDir: string;
let instance: ServeInstance | null = null;
let child: ChildProcess | null = null;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "vf-watch-e2e-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-watch-e2e-proj-"));
  ensureTaskDirs(projectDir);
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  child = null;
  if (instance) {
    await instance.close();
    instance = null;
  }
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

async function readSubscribers(): Promise<SubscriberSnapshot> {
  const res = await fetch(
    `${instance!.url}/api/notifications/subscribers`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SubscriberSnapshot;
}

/** Bounded poll: wait for a state, never sleep-and-hope. */
async function waitForSubscribers(
  predicate: (snapshot: SubscriberSnapshot) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<SubscriberSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = await readSubscribers();
  while (!predicate(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label}; last snapshot: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
    last = await readSubscribers();
  }
  return last;
}

describe("local subscriber routes", () => {
  it("registers, heartbeats idempotently and unregisters by id", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      // @internal test hooks — force OFFLINE mode deterministically.
      _testToken: null,
      _testWorkspace: null,
    });

    const post = await fetch(`${instance.url}/api/notifications/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriberId: "sub_manual", agent: "claude" }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({
      subscriberId: "sub_manual",
      total: 1,
    });

    // Same id again = heartbeat, not a second watcher.
    const heartbeat = await fetch(
      `${instance.url}/api/notifications/subscribers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriberId: "sub_manual", agent: "claude" }),
      },
    );
    expect(await heartbeat.json()).toEqual({
      subscriberId: "sub_manual",
      total: 1,
    });

    expect(await readSubscribers()).toEqual({
      total: 1,
      byUser: [{ user: "local", agents: 1 }],
      byAgent: [{ agent: "claude", count: 1 }],
    });

    const del = await fetch(
      `${instance.url}/api/notifications/subscribers/sub_manual`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ removed: true, total: 0 });

    // Idempotent: a departing follower retrying is not an error.
    const again = await fetch(
      `${instance.url}/api/notifications/subscribers/sub_manual`,
      { method: "DELETE" },
    );
    expect(await again.json()).toEqual({ removed: false, total: 0 });
  });

  it("refuses a malformed subscriber id with INVALID_SUBSCRIBER", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    const res = await fetch(`${instance.url}/api/notifications/subscribers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriberId: "" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_SUBSCRIBER" });
  });
});

describe("vibeflow notifications --follow as a subscriber", () => {
  it("keeps --json stdout pure while registering (no side-channel output)", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    const port = Number(new URL(instance.url).port);
    writeConfig(projectDir, { port });

    child = spawn(
      process.execPath,
      [CLI_ENTRY, "notifications", "--follow", "--local", "--json"],
      {
        cwd: projectDir,
        env: isolatedCliEnv({
          home: cliHome,
          cwd: projectDir,
          env: { VIBEFLOW_EVENTS: "1", VIBEFLOW_ACTOR: "e2e-watcher" },
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => (stdout += d));

    await waitForSubscribers(
      (snapshot) => snapshot.total === 1,
      "the follower to register",
    );
    // No events happened: a pure `--json` follower writes NOTHING to stdout.
    // Registration diagnostics (if any) belong to stderr.
    expect(stdout).toBe("");

    child.kill("SIGINT");
    await new Promise<void>((resolve) => child!.once("close", () => resolve()));
    expect(stdout).toBe("");
  }, 40_000);

  it("registers the follower, then unregisters on SIGINT (no ghost)", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    // The follower discovers the board through the project's config port —
    // the real serve command's port can differ, so pin the test's instance.
    const port = Number(new URL(instance.url).port);
    writeConfig(projectDir, { port });

    child = spawn(
      process.execPath,
      [CLI_ENTRY, "notifications", "--follow", "--local"],
      {
        cwd: projectDir,
        env: isolatedCliEnv({
          home: cliHome,
          cwd: projectDir,
          env: { VIBEFLOW_EVENTS: "1", VIBEFLOW_ACTOR: "e2e-watcher" },
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => {
      child!.on("close", (code) => resolve(code));
    });

    const registered = await waitForSubscribers(
      (snapshot) => snapshot.total === 1,
      "the follower to register",
    );
    expect(registered.byUser).toEqual([{ user: "local", agents: 1 }]);
    expect(registered.byAgent).toEqual([
      { agent: "e2e-watcher", count: 1 },
    ]);

    child.kill("SIGINT");
    expect(await exited).toBe(0);

    // Unregistered BEFORE exit: the registry is empty without waiting 90 s.
    const after = await waitForSubscribers(
      (snapshot) => snapshot.total === 0,
      "the follower to unregister",
    );
    expect(after).toEqual({ total: 0, byUser: [], byAgent: [] });
    expect(stderr).not.toContain("at ");
  }, 40_000);
});
