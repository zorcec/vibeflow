/**
 * A follower must survive the network (ticket liolbrdi).
 *
 * The old loop treated any failed poll as fatal: it stopped the heartbeat,
 * unregistered the watcher and returned. One blip — a deploy, a proxy reset, a
 * 503 — and the agent went silent for good, which is the worst failure a
 * notifier has because nothing announces it.
 *
 * These drive the REAL binary against a local HTTP double that fails on
 * purpose, so the policy is pinned on the wire rather than asserted in a unit
 * test: retry with backoff, resume from the cursor (no duplicates), recover
 * from an expired cursor, obey `Retry-After`, and still stop for a credential
 * that will never fix itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { isolatedCliEnv } from "./spawn-isolated.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

interface Captured {
  at: number;
  path: string;
  since: string | null;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];
/**
 * Per-FEED-request answer; the tests swap it mid-flight. The CLI probes
 * `/api/v0/settings` and registers a subscriber before it ever reads the feed,
 * so the failure has to be scoped to the feed path or the run dies in the
 * preflight and proves nothing about the loop.
 */
let respond: (res: ServerResponse, feedIndex: number) => void;

let home: string;
let projectDir: string;

/** Feed requests only — the number the resilience assertions are about. */
const feedRequests = (): Captured[] =>
  captured.filter((c) => c.path === "/api/v0/notifications");

/** One event, unique per test so a stale print cannot pass as delivery. */
function envelope(id: string, ts: string): unknown {
  return {
    notifications: [
      { id, ts, type: "task.comment", taskId: "aaa11111", actor: "human" },
    ],
    nextTs: ts,
    earliestTs: ts,
    gap: false,
    truncated: false,
    count: 1,
  };
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  captured = [];
  respond = (res) => json(res, 200, envelope("evt_default", "2026-11-25T10:00:00.000Z"));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    captured.push({
      at: Date.now(),
      path: url.pathname,
      since: url.searchParams.get("since"),
    });
    if (url.pathname !== "/api/v0/notifications") {
      // Preflight, subscriber registration, anything else: always healthy, so
      // the only thing under test is the feed loop.
      return json(res, 200, envelope("evt_probe", "2026-11-25T09:59:00.000Z"));
    }
    respond(res, feedRequests().length - 1);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  home = mkdtempSync(join(tmpdir(), "vf-resil-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-resil-proj-"));
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
  const credentialsPath = join(home, ".vibeflow", "credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      [baseUrl]: {
        token: "vbf_pat_deadbeef_testonly",
        workspaceId: "board-xyz",
        account: "e2e@vibeflow.tools",
        updatedAt: "2026-11-22T00:00:00.000Z",
      },
    }),
  );
  chmodSync(credentialsPath, 0o600);
  writeFileSync(
    join(projectDir, ".vibeflow", "settings.json"),
    JSON.stringify({ workspace: { apiUrl: baseUrl, id: "board-xyz" } }),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

interface Follower {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Wait until `predicate` holds; throws with both streams when it times out. */
  until: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
  /** Wait for the process to exit on its own. */
  exit: (timeoutMs?: number) => Promise<number | null>;
  stop: () => Promise<number | null>;
}

function startFollower(envOverrides: Record<string, string> = {}): Follower {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "notifications", "--online", "--follow", "--json"],
    {
      cwd: projectDir,
      env: isolatedCliEnv({
        home,
        cwd: projectDir,
        env: {
          VIBEFLOW_API_URL: baseUrl,
          VIBEFLOW_EVENTS: "1",
          VIBEFLOW_HOOKS: "0",
          ...envOverrides,
        },
      }),
    },
  );
  let out = "";
  let err = "";
  child.stdout?.on("data", (c) => (out += c.toString()));
  child.stderr?.on("data", (c) => (err += c.toString()));

  const until = async (predicate: () => boolean, timeoutMs = 20_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `condition not met within ${timeoutMs} ms\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
    );
  };

  const exit = (timeoutMs = 20_000): Promise<number | null> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`follower did not exit\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
      }, timeoutMs);
      child.once("close", (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });

  const stop = async (): Promise<number | null> => {
    const done = exit();
    child.kill("SIGTERM");
    return done;
  };

  return { child, stdout: () => out, stderr: () => err, until, exit, stop };
}

describe("notifications --follow resilience (e2e, failing HTTP double)", () => {
  it("retries a 503 burst, then delivers — the follower never exits", async () => {
    respond = (res, index) => {
      if (index < 2) return json(res, 503, { error: "unavailable" });
      return json(res, 200, envelope("evt_after_outage", "2026-11-25T10:00:01.000Z"));
    };

    const follower = startFollower();
    try {
      await follower.until(() => follower.stdout().includes("evt_after_outage"));
      expect(follower.stderr()).toContain("retrying");
      expect(follower.stderr()).toContain("reconnected after 2");
      // It is still a live follower after the outage, not a one-shot that got
      // lucky: killing it is what ends it.
      const status = await follower.stop();
      expect(status, follower.stderr()).toBe(0);
      expect(feedRequests().length).toBeGreaterThanOrEqual(3);
    } finally {
      if (follower.child.exitCode === null) follower.child.kill("SIGKILL");
    }
  });

  it("resumes from its cursor after an outage — the event is printed once", async () => {
    respond = (res, index) => {
      if (index === 0) return json(res, 200, envelope("evt_first", "2026-11-25T10:00:00.000Z"));
      if (index === 1) return json(res, 500, { error: "boom" });
      // The board replays inclusively from `since`; the client must dedupe.
      return json(res, 200, envelope("evt_first", "2026-11-25T10:00:00.000Z"));
    };

    const follower = startFollower();
    try {
      await follower.until(() => follower.stderr().includes("reconnected"));
      await new Promise((r) => setTimeout(r, 500));
      const occurrences = follower.stdout().split("evt_first").length - 1;
      expect(occurrences).toBe(1);
      // The retry carried the cursor forward rather than restarting from now.
      expect(feedRequests()[2]?.since).toBe("2026-11-25T10:00:00.000Z");
      await follower.stop();
    } finally {
      if (follower.child.exitCode === null) follower.child.kill("SIGKILL");
    }
  });

  it("recovers from a cursor it can never use again, and says so", async () => {
    respond = (res, index) => {
      if (index === 0) {
        // A `nextTs` the client cannot parse becomes INVALID_SINCE on the next
        // poll: the typed "discard your position" answer, not a retry loop.
        return json(res, 200, {
          notifications: [],
          nextTs: "not-a-date",
          earliestTs: null,
          gap: false,
          truncated: false,
          count: 0,
        });
      }
      return json(res, 200, envelope("evt_after_reset", "2026-11-25T10:00:02.000Z"));
    };

    const follower = startFollower();
    try {
      await follower.until(() => follower.stdout().includes("evt_after_reset"));
      expect(follower.stderr()).toContain("cursor expired");
      // Recovery drops the cursor: the next request carries none.
      expect(feedRequests().at(-1)?.since).toBeNull();
      await follower.stop();
    } finally {
      if (follower.child.exitCode === null) follower.child.kill("SIGKILL");
    }
  });

  it("obeys Retry-After on a 429 instead of hammering the board", async () => {
    respond = (res, index) => {
      if (index === 0) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        return res.end(JSON.stringify({ error: "slow down" }));
      }
      return json(res, 200, envelope("evt_after_429", "2026-11-25T10:00:03.000Z"));
    };

    const follower = startFollower();
    try {
      await follower.until(() => follower.stdout().includes("evt_after_429"));
      const gap = (feedRequests()[1]?.at ?? 0) - (feedRequests()[0]?.at ?? 0);
      // Without the header the first backoff is <= 500 ms; honouring it is the
      // only way this gap reaches ~1 s.
      expect(gap).toBeGreaterThanOrEqual(900);
      await follower.stop();
    } finally {
      if (follower.child.exitCode === null) follower.child.kill("SIGKILL");
    }
  });

  it("stops for a 401 — a bad credential is not a transient condition", async () => {
    respond = (res) => json(res, 401, { error: "unauthorized" });

    const follower = startFollower();
    try {
      const status = await follower.exit(20_000);
      expect(status, follower.stderr()).not.toBe(0);
      // Exactly one attempt: retrying a credential that will never change is a
      // busy loop with a friendly face.
      expect(feedRequests().length).toBe(1);
      expect(follower.stderr()).toContain("HTTP 401");
    } finally {
      if (follower.child.exitCode === null) follower.child.kill("SIGKILL");
    }
  });
});

/**
 * Self-suppression on the HOSTED feed (ticket kzxaq0fd). `actor` is the
 * credential owner (shared by every agent on one PAT); `agent` is the
 * caller-declared writer the hosted route threads from `X-Vibeflow-Agent`
 * into the ring. The follower filters on `agent` ONLY — the same binary and
 * the same loop as the local path, so this pins the delivery rule on a
 * hosted-shaped payload without a stack.
 */
describe("notifications --follow self-suppression (hosted feed)", () => {
  it("suppresses its own agent's event; a peer's and an unidentified one pass", async () => {
    const ts = "2026-11-25T10:00:00.000Z";
    respond = (res) =>
      json(res, 200, {
        notifications: [
          { id: "evt_own", ts, type: "task.comment", taskId: "t1", actor: "user-1", agent: "pi-a" },
          { id: "evt_peer", ts, type: "task.comment", taskId: "t1", actor: "user-1", agent: "pi-b" },
          { id: "evt_unknown", ts, type: "task.comment", taskId: "t1", actor: "user-1" },
        ],
        nextTs: ts,
        earliestTs: ts,
        gap: false,
        truncated: false,
        count: 3,
      });

    const a = startFollower({ VIBEFLOW_ACTOR: "pi-a" });
    const b = startFollower({ VIBEFLOW_ACTOR: "pi-b" });
    try {
      await a.until(
        () => a.stdout().includes("evt_peer") && a.stdout().includes("evt_unknown"),
      );
      await b.until(
        () => b.stdout().includes("evt_own") && b.stdout().includes("evt_unknown"),
      );
      // At least one more poll each: a suppressed event must not appear late.
      await new Promise((r) => setTimeout(r, 2_500));

      expect(a.stdout()).not.toContain("evt_own");
      expect(b.stdout()).not.toContain("evt_peer");
      // The delivered payload keeps BOTH identities, so a consumer can decide
      // for itself: `agent` names the writer, `actor` stays the token owner.
      expect(a.stdout()).toContain('"agent":"pi-b"');
      expect(a.stdout()).toContain('"actor":"user-1"');
      expect(b.stdout()).toContain('"agent":"pi-a"');
    } finally {
      for (const follower of [a, b]) {
        if (follower.child.exitCode === null) follower.child.kill("SIGKILL");
      }
    }
  });
});
