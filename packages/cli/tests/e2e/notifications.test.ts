/**
 * `GET /api/notifications` end to end (ticket ecba6126): a real CLI spawn in a
 * temp project mutates the store, and the board served in-process reads the
 * event back out of `<project>/.vibeflow/notifications.jsonl`.
 *
 * The `since` token is INCLUSIVE by design (at-least-once: a boundary event
 * may repeat, never disappear), so "nothing new" is asserted on IDS, not on an
 * empty page — a poll that renames the boundary event it already knows is the
 * contract working, not a duplicate write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWithPort } from "../helpers/serve-with-port.js";
import { spawnCliIsolated } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";
import type { ServeInstance } from "../../src/server/server.js";
import type {
  NotificationEvent,
  NotificationReadResult,
} from "../../src/core/notifications.js";

/** The unit setup pins `VIBEFLOW_EVENTS=0`; a spawned child opts back in. */
const EVENTS_ON = { VIBEFLOW_EVENTS: "1" };

let cliHome: string;
let projectDir: string;
let instance: ServeInstance | null = null;

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "vf-notify-e2e-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-notify-e2e-proj-"));
  ensureTaskDirs(projectDir);
});

afterEach(async () => {
  if (instance) {
    await instance.close();
    instance = null;
  }
  rmSync(cliHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

/** Poll the board's notification route, exactly as a client would. */
async function fetchNotifications(
  query: { since?: string; limit?: number } = {},
): Promise<NotificationReadResult> {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set("since", query.since);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(
    `${instance!.url}/api/notifications${suffix}`,
  );
  expect(response.ok).toBe(true);
  return (await response.json()) as NotificationReadResult;
}

/** Run the CLI in the temp project with the event log switched ON. */
async function runCli(args: string[]): Promise<void> {
  const run = await spawnCliIsolated(args, {
    cwd: projectDir,
    home: cliHome,
    env: EVENTS_ON,
  });
  // Exit code only: a passing run may still narrate on stderr, and a failing
  // one is reported through the code plus the captured streams.
  expect(run.code, `stderr: ${run.stderr}`).toBe(0);
}

describe("GET /api/notifications (e2e)", () => {
  it("reports an empty feed for a fresh project, then one event per local mutation", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      // @internal test hooks — force OFFLINE mode deterministically.
      _testToken: null,
      _testWorkspace: null,
    });

    const empty = await fetchNotifications();
    expect(empty).toEqual({
      notifications: [],
      nextTs: null,
      earliestTs: null,
      gap: false,
      truncated: false,
      count: 0,
    });

    // ── task.create ──────────────────────────────────────────────────────
    await runCli(["tasks", "--add", "--title", "notification e2e task", "--json"]);
    const afterAdd = await fetchNotifications();
    expect(afterAdd.count).toBe(1);
    const created: NotificationEvent = afterAdd.notifications[0]!;
    expect(created.type).toBe("task.create");
    expect(created.actor).toBe("agent");
    expect(created.id).toMatch(/^evt_[a-z2-7]{26}$/);
    expect(afterAdd.earliestTs).toBe(created.ts);
    expect(afterAdd.nextTs).toBe(created.ts);
    expect(afterAdd.gap).toBe(false);

    // ── task.update (the status move), polled from the previous token ────
    await runCli([
      "tasks",
      "--edit",
      created.taskId,
      "--set-status",
      "in-progress",
      "--json",
    ]);
    const afterEdit = await fetchNotifications({ since: afterAdd.nextTs! });
    const newAfterEdit = afterEdit.notifications.filter(
      (event) => event.id !== created.id,
    );
    expect(newAfterEdit).toHaveLength(1);
    expect(newAfterEdit[0]!.type).toBe("task.update");
    expect(newAfterEdit[0]!.taskId).toBe(created.taskId);
    // The event is projected from the CONFIRMED `task.update` payload, so
    // `changed` is the key list the operation actually wrote — richer than
    // the flag names the caller passed (`--set-status` also stamps `author`
    // and resets `verified` to "absent"). That is the point of the
    // projection: one description of the write, not a second one.
    expect(newAfterEdit[0]!.changed).toEqual(["status", "author", "verified"]);
    // `to` (new values per key) is only emitted where the confirmed payload
    // carries them (`task.create`/`task.claim`/`task.delete`/`task.comment`/
    // `verify`); a `task.update` payload names the keys, not the values.
    expect(newAfterEdit[0]!.to).toBeUndefined();
    expect(afterEdit.count).toBe(2);

    // ── the same token again: nothing NEW was written ────────────────────
    // The boundary event itself may repeat (inclusive `since`), so the
    // assertion is on ids, never on an empty page.
    const seen = new Set(afterEdit.notifications.map((event) => event.id));
    const replays = await fetchNotifications({ since: afterEdit.nextTs! });
    expect(replays.notifications.filter((e) => !seen.has(e.id))).toEqual([]);
    expect(replays.earliestTs).toBe(created.ts);

    // ── a READ writes nothing ────────────────────────────────────────────
    await runCli(["tasks", "--get", created.taskId]);
    const afterRead = await fetchNotifications({ since: afterEdit.nextTs! });
    expect(afterRead.notifications.filter((e) => !seen.has(e.id))).toEqual([]);

    // ── ONE command, TWO confirmed effects ⇒ two events ──────────────────
    // `--edit --set-status --comment` confirms `task.update` AND
    // `task.comment`. Reporting only the last would hide that the status
    // moved; the boundary projects one event per confirmed effect.
    const beforeBoth = await fetchNotifications({ since: afterEdit.nextTs! });
    const seenBeforeBoth = new Set(
      beforeBoth.notifications.map((event) => event.id),
    );
    await runCli([
      "tasks",
      "--edit",
      created.taskId,
      "--set-status",
      "review",
      "--comment",
      "two effects, one command",
      "--json",
    ]);
    const afterBoth = await fetchNotifications({ since: beforeBoth.nextTs! });
    const fresh = afterBoth.notifications.filter(
      (event) => !seenBeforeBoth.has(event.id),
    );
    expect(fresh.map((event) => event.type)).toEqual([
      "task.update",
      "task.comment",
    ]);
    expect(fresh.every((event) => event.taskId === created.taskId)).toBe(true);
    expect(fresh[1]!.to).toMatchObject({});
  });

  it("rejects a `since` that is not a parseable ISO timestamp", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    const response = await fetch(
      `${instance.url}/api/notifications?since=not-a-date`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      message: string;
      expectedFormat: string;
      example: string;
    };
    expect(body.error).toBe("INVALID_SINCE");
    // The error must be actionable on its own: an agent that guessed `since`
    // wrong needs the shape and a working example, not just the code.
    expect(body.expectedFormat).toBe("YYYY-MM-DDTHH:mm:ss.sssZ");
    expect(body.example).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(body.message).toContain(body.example);
    expect(body.message).toContain("nextTs");
  });
});
