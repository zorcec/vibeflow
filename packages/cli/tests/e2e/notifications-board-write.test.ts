/**
 * Board writes must reach the notification feed (ticket mzxp8u98).
 *
 * The bug: a comment typed into the local board called `broadcastTaskUpdated`
 * (a WebSocket frame for the open tab) and nothing else — the notification
 * store was written only by the CLI/MCP boundary, so a board comment was
 * invisible to every follower forever.
 *
 * This boots the real board and spawns the BUILT `notifications --follow
 * --local --json`, then pins:
 *   - a board comment appends ONE `task.comment` event naming the comment and
 *     the live follower prints it;
 *   - the CLI `--comment` path still emits exactly ONE comment event (the two
 *     paths produce one event each, never a duplicate);
 *   - comment edit/delete emit NOTHING (documented decision: the vocabulary
 *     has only a comment-ADDED activity, and the hosted ring maps edit/remove
 *     to null for the same reason);
 *   - a status edit emits `task.update (status)`, while a bookkeeping-only
 *     edit (sortKey) emits nothing — the metadata-only rule still holds.
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
import type {
  NotificationEvent,
  NotificationReadResult,
} from "../../src/core/notifications.js";
import type { SubscriberSnapshot } from "../../src/core/subscribers.js";

let cliHome: string;
let projectDir: string;
let instance: ServeInstance | null = null;
let follower: ChildProcess | null = null;
let followerOut = "";
const savedEvents = process.env.VIBEFLOW_EVENTS;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "vf-boardwrite-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-boardwrite-proj-"));
  ensureTaskDirs(projectDir);
  followerOut = "";
  // The board emits in THIS process: its routes call the notification seam
  // directly, so the test process needs the kill switch off (the shared setup
  // pins it to 0 for hermeticity).
  process.env.VIBEFLOW_EVENTS = "1";
});

afterEach(async () => {
  if (follower && follower.exitCode === null && follower.signalCode === null) {
    follower.kill("SIGKILL");
  }
  follower = null;
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

/** Bounded poll of the subscriber roster (the follower registers on start). */
async function waitForFollower(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${instance!.url}/api/notifications/subscribers`);
    const snapshot = (await res.json()) as SubscriberSnapshot;
    if (snapshot.total === 1) return;
    if (Date.now() > deadline) {
      throw new Error(`follower never registered; last: ${JSON.stringify(snapshot)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}; stdout:\n${followerOut}`);
}

async function bootBoard(): Promise<void> {
  instance = await serveWithPort(undefined, {
    open: false,
    projectDir,
    // @internal test hooks — force OFFLINE mode deterministically.
    _testToken: null,
    _testWorkspace: null,
  });
  follower = spawn(
    process.execPath,
    [CLI_ENTRY, "notifications", "--follow", "--local", "--json"],
    {
      cwd: projectDir,
      env: isolatedCliEnv({
        home: cliHome,
        cwd: projectDir,
        env: { VIBEFLOW_EVENTS: "1", VIBEFLOW_ACTOR: "e2e-follower" },
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  follower.stdout!.setEncoding("utf8");
  follower.stdout!.on("data", (d: string) => (followerOut += d));
  await waitForFollower();
}

/** Create a task through the BOARD's own route (a real board write). */
async function createBoardTask(): Promise<string> {
  const res = await fetch(`${instance!.url}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "board writer", selector: "#board" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: { id: string } };
  return body.task.id;
}

async function runCli(args: string[], env: Record<string, string>): Promise<void> {
  const run = await spawnCliIsolated(args, {
    cwd: projectDir,
    home: cliHome,
    env: { VIBEFLOW_EVENTS: "1", ...env },
  });
  expect(run.code, `stderr: ${run.stderr}`).toBe(0);
}

describe("board writes → notification feed (e2e)", () => {
  it("a board comment appends ONE task.comment event and reaches a live follower", async () => {
    await bootBoard();
    const taskId = await createBoardTask();

    const posted = await fetch(`${instance!.url}/api/tasks/${taskId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "user", text: "typed on the board" }),
    });
    expect(posted.status).toBe(200);
    const comment = ((await posted.json()) as { comment: { id: string } }).comment;

    await until(
      () => followerOut.includes('"type":"task.comment"'),
      "the follower to print the board comment",
    );

    const feed = await readFeed();
    expect(feed.count).toBe(1);
    expect(feed.notifications[0]).toMatchObject({
      type: "task.comment",
      taskId,
      actor: "board",
      to: { commentId: comment.id },
    });
    // A human board write names no agent: it is never "self" for a follower.
    expect(feed.notifications[0]).not.toHaveProperty("agent");
    // The delivered JSON is the stored event verbatim (payload intact).
    expect(followerOut).toContain(`"commentId":"${comment.id}"`);

    // ── the CLI path still emits exactly ONE comment event ───────────────
    await runCli(
      ["tasks", "--edit", taskId, "--comment", "typed in the terminal", "--json"],
      {},
    );
    const afterCli = await readFeed();
    const comments = afterCli.notifications.filter(
      (event) => event.type === "task.comment" && event.taskId === taskId,
    );
    // Two comment writes, two events — the board did not duplicate the CLI's
    // and the CLI did not duplicate the board's.
    expect(comments).toHaveLength(2);
    expect(new Set(comments.map((event) => event.to?.commentId)).size).toBe(2);
    expect(comments.map((event) => event.actor).sort()).toEqual([
      "agent",
      "board",
    ]);
  }, 60_000);

  it("comment edit/delete emit NO event (documented refusal)", async () => {
    await bootBoard();
    const taskId = await createBoardTask();
    const posted = await fetch(`${instance!.url}/api/tasks/${taskId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "user", text: "to be edited" }),
    });
    const comment = ((await posted.json()) as { comment: { id: string } }).comment;
    const baseline = await readFeed();
    expect(baseline.count).toBe(1);

    const patched = await fetch(
      `${instance!.url}/api/tasks/${taskId}/comments/${comment.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "edited" }),
      },
    );
    expect(patched.status).toBe(200);
    const deleted = await fetch(
      `${instance!.url}/api/tasks/${taskId}/comments/${comment.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);

    const after = await readFeed();
    // The activity vocabulary has only a comment-ADDED activity, and the
    // hosted ring maps comment.update/remove to null — one contract, both
    // backends. The WebSocket broadcast still refreshed the open board.
    expect(after.count).toBe(baseline.count);
  }, 60_000);

  it("a status edit emits task.update(status); a bookkeeping-only edit emits nothing", async () => {
    await bootBoard();
    const taskId = await createBoardTask();

    const patched = await fetch(`${instance!.url}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in-progress" }),
    });
    expect(patched.status).toBe(200);

    const first = await readFeed();
    const updates: NotificationEvent[] = first.notifications.filter(
      (event) => event.type === "task.update" && event.taskId === taskId,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.changed).toEqual(["status"]);
    expect(updates[0]!.actor).toBe("board");

    // sortKey is bookkeeping: a reorder must not wake an agent.
    const reordered = await fetch(`${instance!.url}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sortKey: "0000000000000001" }),
    });
    expect(reordered.status).toBe(200);
    const after = await readFeed();
    expect(after.count).toBe(first.count);
  }, 60_000);
});
