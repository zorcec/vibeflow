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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWithPort } from "../helpers/serve-with-port.js";
import { CLI_ENTRY, isolatedCliEnv } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";
import { readConfig, writeConfig } from "../../src/core/config.js";
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

    // Same id again = heartbeat, not a second watcher. It carries the
    // follower's last delivered event (ticket ifhh7q2) with its DELIVERY time.
    const activity = {
      type: "task.claim",
      taskId: "ifhh7q2jukxhqcrs5kfo6mb8",
      at: Date.now(),
    };
    const heartbeat = await fetch(
      `${instance.url}/api/notifications/subscribers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscriberId: "sub_manual",
          agent: "claude",
          activity,
        }),
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
      subscribers: [
        {
          subscriberId: "sub_manual",
          user: "local",
          agent: "claude",
          registeredAt: expect.any(Number),
          lastSeenAt: expect.any(Number),
          activity,
        },
      ],
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

  it("carries a status-only update: truncate to 140, drop a bad at, preserve on heartbeat, never touch liveness", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    const post = (body: unknown) =>
      fetch(`${instance!.url}/api/notifications/subscribers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    expect(
      (await post({ subscriberId: "sub_status", agent: "claude" })).status,
    ).toBe(200);
    const before = (await readSubscribers()).subscribers[0]!;
    // A follower that never set one has NO status key — never a placeholder.
    expect(before).not.toHaveProperty("status");

    // Make a lastSeenAt refresh observable: same-ms writes would hide it.
    await new Promise((r) => setTimeout(r, 30));
    const at = Date.now();
    const set = await post({
      subscriberId: "sub_status",
      status: { text: "s".repeat(500), at },
    });
    expect(set.status).toBe(200);
    let row = (await readSubscribers()).subscribers[0]!;
    // Truncated to 140 (the badge's one ellipsised line), never rejected;
    // `at` travels verbatim — it is the SET time, not the delivery time.
    expect(row.status).toEqual({ text: "s".repeat(140), at });
    // The status-only update must NOT refresh the liveness clock: a one-shot
    // command cannot resurrect a dead follower's row (ticket w7knq2anvb14axzpea5k7qwv).
    expect(row.lastSeenAt).toBe(before.lastSeenAt);

    // A heartbeat without a status PRESERVES it (amended spec, ticket
    // comment hxlw25pmk46pcgscoc3svrou) — unlike activity, which clears.
    expect(
      (await post({ subscriberId: "sub_status", agent: "claude" })).status,
    ).toBe(200);
    row = (await readSubscribers()).subscribers[0]!;
    expect(row.status).toEqual({ text: "s".repeat(140), at });
    // The heartbeat itself still refreshes liveness — that part is unchanged.
    expect(row.lastSeenAt).toBeGreaterThan(before.lastSeenAt);

    // {at:-1} is DROPPED: the update changes nothing, never a 400.
    const bad = await post({
      subscriberId: "sub_status",
      status: { text: "bad at", at: -1 },
    });
    expect(bad.status).toBe(200);
    row = (await readSubscribers()).subscribers[0]!;
    expect(row.status).toEqual({ text: "s".repeat(140), at });

    // status: null clears explicitly — and the row itself survives.
    expect(
      (await post({ subscriberId: "sub_status", status: null })).status,
    ).toBe(200);
    row = (await readSubscribers()).subscribers[0]!;
    expect(row).not.toHaveProperty("status");
    expect((await readSubscribers()).total).toBe(1);

    // The authority on liveness: an absent row is 409 NO_LIVE_AGENT and
    // nothing is written — the status never brings a dead follower back.
    const dead = await post({
      subscriberId: "sub_nobody",
      status: { text: "ghost", at },
    });
    expect(dead.status).toBe(409);
    expect(await dead.json()).toMatchObject({ code: "NO_LIVE_AGENT" });
    expect((await readSubscribers()).total).toBe(1);
  });

  it("vibeflow agents status with no live follower exits 2 (E_USAGE) and posts nothing", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    // The follower discovers the board through the project's config port.
    const port = Number(new URL(instance.url).port);
    writeConfig(projectDir, { port });

    child = spawn(
      process.execPath,
      [CLI_ENTRY, "agents", "status", "hello there", "--local", "--json"],
      {
        cwd: projectDir,
        env: isolatedCliEnv({ home: cliHome, cwd: projectDir, env: {} }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => (stderr += d));
    const code = await new Promise<number | null>((resolve) => {
      child!.on("close", (c) => resolve(c));
    });

    expect(code).toBe(2);
    expect(stderr).toContain('"code":"E_USAGE"');
    // Nothing was posted: the roster is exactly what it was.
    const snapshot = await readSubscribers();
    expect(snapshot.total).toBe(0);
    expect(snapshot.subscribers).toEqual([]);
  }, 40_000);
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
    expect(after).toEqual({
      total: 0,
      byUser: [],
      byAgent: [],
      subscribers: [],
    });
    expect(stderr).not.toContain("at ");
  }, 40_000);

  it("unregisters on SIGHUP — closing the terminal must not leave a ghost", async () => {
    // SIGHUP is the signal a closed terminal or a dying harness actually sends,
    // and Node's default for it is exit WITHOUT running handlers — which is how
    // the owner ended up with an agent still on the watching list after closing
    // the harness (ticket lf6ekg9l).
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
      [CLI_ENTRY, "notifications", "--follow", "--local"],
      {
        cwd: projectDir,
        env: isolatedCliEnv({
          home: cliHome,
          cwd: projectDir,
          env: { VIBEFLOW_EVENTS: "1", VIBEFLOW_ACTOR: "e2e-hup" },
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<number | null>((resolve) => {
      child!.on("close", (code) => resolve(code));
    });

    await waitForSubscribers((s) => s.total === 1, "the follower to register");
    child.kill("SIGHUP");
    expect(await exited).toBe(0);
    const after = await waitForSubscribers(
      (s) => s.total === 0,
      "the follower to unregister after SIGHUP",
    );
    expect(after.total).toBe(0);
  }, 40_000);

  it("exits when its parent dies (a hard-killed harness leaves no ghost)", async () => {
    // The real-world case: pi is killed (or the window closes) and the follower
    // is reparented. It used to keep heartbeating forever, so the agent stayed
    // on the watching list permanently. The wrapper gives the follower a
    // throwaway parent, and its stdio is ignored so ONLY the orphan watchdog
    // can stop it — a broken pipe must not be what makes this test pass.
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    const port = Number(new URL(instance.url).port);
    writeConfig(projectDir, { port });

    const wrapperPath = join(projectDir, "orphan-wrapper.mjs");
    writeFileSync(
      wrapperPath,
      `
import { spawn } from "node:child_process";
const [entry, ...args] = process.argv.slice(2);
spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "ignore", "ignore"] });
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const wrapper = spawn(process.execPath, [
      wrapperPath,
      CLI_ENTRY,
      "notifications",
      "--follow",
      "--local",
    ], {
      cwd: projectDir,
      env: isolatedCliEnv({
        home: cliHome,
        cwd: projectDir,
        env: { VIBEFLOW_EVENTS: "1", VIBEFLOW_ACTOR: "e2e-orphan" },
      }),
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      await waitForSubscribers((s) => s.total === 1, "the follower to register");
      wrapper.kill("SIGKILL");
      const after = await waitForSubscribers(
        (s) => s.total === 0,
        "the orphaned follower to unregister itself",
        20_000,
      );
      expect(after.total).toBe(0);
    } finally {
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill("SIGKILL");
      }
    }
  }, 40_000);

  it("two followers of the SAME agent are one subscriber, not two rows", async () => {
    // The reported bug (ticket iwibqqek): the badge said "8 agents following"
    // with eight identical rows named "agent" — every follower restart had
    // minted a fresh random key, so re-registration could not be idempotent.
    // Two processes standing in for a restart must land on ONE row.
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    const port = Number(new URL(instance.url).port);
    writeConfig(projectDir, { port });

    const followers: ChildProcess[] = [];
    const spawnFollower = (): ChildProcess => {
      const proc = spawn(
        process.execPath,
        [CLI_ENTRY, "notifications", "--follow", "--local"],
        {
          cwd: projectDir,
          env: isolatedCliEnv({
            home: cliHome,
            cwd: projectDir,
            env: { VIBEFLOW_EVENTS: "1", VIBEFLOW_ACTOR: "e2e-same-agent" },
          }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      followers.push(proc);
      return proc;
    };
    try {
      spawnFollower();
      await waitForSubscribers((s) => s.total === 1, "the first follower");
      spawnFollower();

      // Give the second one time to register, then assert it did NOT add a row.
      // A bounded poll on "total stays 1" would pass instantly; poll for the
      // second process to be alive instead, so the assertion means something.
      const deadline = Date.now() + 15_000;
      let seen = await readSubscribers();
      while (seen.total === 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        seen = await readSubscribers();
      }
      expect(seen.total, `rows: ${JSON.stringify(seen.subscribers)}`).toBe(1);
      expect(seen.subscribers).toHaveLength(1);
      expect(seen.subscribers[0]!.agent).toBe("e2e-same-agent");
      // Same key on both, by construction.
      expect(seen.subscribers[0]!.subscriberId).toMatch(/^sub_[0-9a-f]{26}$/);
    } finally {
      for (const proc of followers) {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }
    }
  }, 60_000);

  it("finds a custom serve port with no flag (serve publishes config.json)", async () => {
    // Ticket xy58j31z: `serve -p <port>` publishes the port it BOUND; the
    // follower reads `<project>/.vibeflow/config.json` (default 3700). No
    // writeConfig here — that is the whole point.
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    const port = Number(new URL(instance.url).port);
    expect(readConfig(projectDir).port).toBe(port);

    child = spawn(
      process.execPath,
      [CLI_ENTRY, "notifications", "--follow", "--local"],
      {
        cwd: projectDir,
        env: isolatedCliEnv({
          home: cliHome,
          cwd: projectDir,
          env: { VIBEFLOW_EVENTS: "1", VIBEFLOW_ACTOR: "e2e-port-watcher" },
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<number | null>((resolve) => {
      child!.on("close", (code) => resolve(code));
    });

    const registered = await waitForSubscribers(
      (snapshot) => snapshot.total === 1,
      "the follower to register on the published port",
    );
    expect(registered.byAgent).toEqual([
      { agent: "e2e-port-watcher", count: 1 },
    ]);

    child.kill("SIGINT");
    expect(await exited).toBe(0);
  }, 40_000);
});
