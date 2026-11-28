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
// The CLIENT read (what `notifications --follow` polls with), aliased against
// the raw route helper below: this test drives the filter through the client
// at the real served board.
import { fetchNotifications as readViaClient } from "../../src/core/notifications-fetch.js";
import type { ServeInstance } from "../../src/server/server.js";
import type {
  NotificationEvent,
  NotificationReadResult,
  NotificationWaitSignal,
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
  query: {
    since?: string;
    limit?: number;
    // A dimension takes a token OR a list: a list is serialised as REPEATED
    // params — the OR wire contract (ticket kjiodwjxmk4j90cek02amgrj).
    taskId?: string | string[];
    type?: string | string[];
    status?: string | string[];
    agent?: string | string[];
    actor?: string | string[];
    taskType?: string | string[];
    wait?: number;
  } = {},
): Promise<NotificationReadResult & { wait?: NotificationWaitSignal }> {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set("since", query.since);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.wait !== undefined) params.set("wait", String(query.wait));
  for (const dimension of [
    "taskId",
    "type",
    "status",
    "agent",
    "actor",
    "taskType",
  ] as const) {
    const value = query[dimension];
    if (value === undefined) continue;
    for (const element of typeof value === "string" ? [value] : value) {
      params.append(dimension, element);
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(
    `${instance!.url}/api/notifications${suffix}`,
  );
  expect(response.ok).toBe(true);
  return (await response.json()) as NotificationReadResult & {
    wait?: NotificationWaitSignal;
  };
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
      filteredCount: 0,
      // The live "working on" claims ride the same answer (ticket qxvptxkta);
      // a board with no follower reporting one still sends the field, so the
      // reader never has to treat absence as a route it can guess at.
      current: [],
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
      code: string;
      details: { expectedFormat: string; example: string };
    };
    // The shared envelope (ticket 0045949e phase 1): `code` is the machine
    // token, `error` the sentence a person reads. Pinned exactly — a stray
    // top-level `message`/`expectedFormat` would mean the old layout leaked
    // back and the two surfaces again answer different shapes.
    expect(Object.keys(body).sort()).toEqual(["code", "details", "error"]);
    expect(body.code).toBe("INVALID_SINCE");
    // The error must be actionable on its own: an agent that guessed `since`
    // wrong needs the shape and a working example, not just the code.
    expect(body.details.expectedFormat).toBe("YYYY-MM-DDTHH:mm:ss.sssZ");
    expect(body.details.example).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(body.error).toContain(body.details.example);
    expect(body.error).toContain("nextTs");
  });

  /**
   * Subscription dimensions over the REAL wire (ticket p3tkodry): the filter
   * runs in the board, the answer still says how many events it dropped, and
   * `nextTs` refuses to step over them.
   */
  it("narrows the page with ?taskId/?type, counts what it dropped and pins nextTs", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    await runCli([
      "tasks",
      "--add",
      "--title",
      "filtered follower task",
      "--json",
    ]);
    const all = await fetchNotifications();
    const created = all.notifications[0]!;
    // One command, two confirmed effects: task.update + task.comment.
    await runCli([
      "tasks",
      "--edit",
      created.taskId,
      "--set-status",
      "in-progress",
      "--comment",
      "filter me",
      "--json",
    ]);

    // Re-read the whole window after the edit: three events, one task.
    const window = await fetchNotifications();
    expect(window.notifications.map((e) => e.type)).toEqual([
      "task.create",
      "task.update",
      "task.comment",
    ]);
    expect(window.count).toBe(3);
    expect(window.filteredCount).toBe(0);

    // Only the comment: two events are dropped and COUNTED, and the cursor
    // stays at the oldest dropped one (the create) — a follower that moved
    // past it could never see those events again after a filter change.
    const comments = await fetchNotifications({ type: "task.comment" });
    expect(comments.notifications.map((e) => e.type)).toEqual(["task.comment"]);
    expect(comments.count).toBe(1);
    expect(comments.filteredCount).toBe(2);
    expect(comments.nextTs).toBe(window.notifications[0]!.ts);

    // A task-scoped read matches every event of that task.
    const scoped = await fetchNotifications({ taskId: created.taskId });
    expect(scoped.count).toBe(3);
    expect(scoped.filteredCount).toBe(0);
    expect(scoped.nextTs).toBe(window.nextTs);

    // A well-formed value this board never emitted narrows to zero — explicit,
    // never widened behind the caller's back.
    const nothing = await fetchNotifications({ agent: "nobody-at-all" });
    expect(nothing.count).toBe(0);
    expect(nothing.filteredCount).toBe(3);

    // An UNKNOWN dimension is not a constraint: it widens, never 400s.
    const unknownDimension = await fetch(
      `${instance.url}/api/notifications?tag=urgent&type=task.comment`,
    );
    expect(unknownDimension.status).toBe(200);
    const widened = (await unknownDimension.json()) as NotificationReadResult;
    expect(widened.count).toBe(1);
    expect(widened.filteredCount).toBe(2);
  });

  it("ORs a repeated param over the wire, skips blank elements, still ANDs across dims", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    await runCli(["tasks", "--add", "--title", "or fixture", "--json"]);
    const all = await fetchNotifications();
    const created = all.notifications[0]!;
    await runCli([
      "tasks",
      "--edit",
      created.taskId,
      "--set-status",
      "in-progress",
      "--comment",
      "or me",
      "--json",
    ]);
    // Three events on one task: create, update, comment.
    const window = await fetchNotifications();
    expect(window.count).toBe(3);

    // Repeated param = OR: both named types come back, the third is dropped
    // AND counted (the old contract silently IGNORED the repeated param).
    const either = await fetchNotifications({
      type: ["task.create", "task.comment"],
    });
    expect(either.notifications.map((e) => e.type)).toEqual([
      "task.create",
      "task.comment",
    ]);
    expect(either.count).toBe(2);
    expect(either.filteredCount).toBe(1);

    // A blank element is not a constraint: it never narrows, never 400s.
    const blankSecond = await fetchNotifications({
      type: ["task.comment", ""],
    });
    expect(blankSecond.count).toBe(1);
    expect(blankSecond.filteredCount).toBe(2);

    // OR within, AND across: (create OR comment) AND this task ⇒ 2 matches.
    const anded = await fetchNotifications({
      type: ["task.create", "task.comment"],
      taskId: created.taskId,
    });
    expect(anded.count).toBe(2);
    expect(anded.filteredCount).toBe(1);

    // …and the AND can still make the whole page empty.
    const never = await fetchNotifications({
      type: ["task.create", "task.comment"],
      taskId: "task-not-on-this-board",
    });
    expect(never.count).toBe(0);
    expect(never.filteredCount).toBe(3);
  });

  it("rejects a bad element ANYWHERE in a repeated param, naming the element", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    await runCli(["tasks", "--add", "--title", "validation fixture", "--json"]);

    type FilterError = {
      error: string;
      code: string;
      details: {
        dimension: string;
        elementIndex: number;
        expectedFormat: string;
        example: string;
      };
    };

    // The SECOND element is the bad one — 129 characters, one past the bound.
    const oversizeSecond = await fetch(
      `${instance.url}/api/notifications?type=task.comment&type=${"x".repeat(129)}`,
    );
    expect(oversizeSecond.status).toBe(400);
    const oversizeBody = (await oversizeSecond.json()) as FilterError;
    expect(oversizeBody.code).toBe("INVALID_FILTER");
    expect(oversizeBody.details.dimension).toBe("type");
    expect(oversizeBody.details.elementIndex).toBe(2);

    // A control character in the FIRST of three is caught just as eagerly —
    // validating only the first element (or only the last) would let 2 and 3
    // through on a future change.
    const controlFirst = await fetch(
      `${instance.url}/api/notifications?type=${encodeURIComponent("a\u0000b")}&type=task.comment&type=ok`,
    );
    expect(controlFirst.status).toBe(400);
    const controlBody = (await controlFirst.json()) as FilterError;
    expect(controlBody.code).toBe("INVALID_FILTER");
    expect(controlBody.details.elementIndex).toBe(1);
    expect(controlBody.error).toContain("type");
  });

  it("narrows with ?actor — this run's own writes match their actor, `board` matches none", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    await runCli(["tasks", "--add", "--title", "actor fixture", "--json"]);
    const all = await fetchNotifications();
    expect(all.count).toBe(1);
    // Whatever identity this environment resolved for the spawned CLI (the
    // explicit $VIBEFLOW_ACTOR, else the shared "agent" label).
    const writer = all.notifications[0]!.actor;

    const byWriter = await fetchNotifications({ actor: writer });
    expect(byWriter.count).toBe(1);
    expect(byWriter.filteredCount).toBe(0);

    // `board` is what a BOARD write carries (a click, a tRPC mutation) — this
    // CLI run never wrote it, so the feed narrows to zero and SAYS why.
    const byBoard = await fetchNotifications({ actor: "board" });
    expect(byBoard.count).toBe(0);
    expect(byBoard.filteredCount).toBe(1);
    // Cursor pinned behind the dropped event: widening later still sees it.
    expect(byBoard.nextTs).toBe(all.notifications[0]!.ts);
  });

  it("narrows with ?taskType through the board's own task list, counting every drop", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    await runCli([
      "tasks",
      "--add",
      "--title",
      "bug fixture",
      "--type",
      "Bug",
      "--json",
    ]);
    await runCli([
      "tasks",
      "--add",
      "--title",
      "research fixture",
      "--type",
      "Research",
      "--json",
    ]);
    const all = await fetchNotifications();
    expect(all.count).toBe(2);
    const bugTaskId = all.notifications[0]!.taskId;
    const researchTaskId = all.notifications[1]!.taskId;
    expect(researchTaskId).not.toBe(bugTaskId);

    const research = await fetchNotifications({ taskType: "Research" });
    expect(research.count).toBe(1);
    expect(research.notifications[0]!.taskId).toBe(researchTaskId);
    expect(research.filteredCount).toBe(1);
    // The bug task's create is dropped, so the cursor sits behind it — a
    // taskType read never steps over events it filtered.
    expect(research.nextTs).toBe(all.notifications[0]!.ts);

    // A type no task on this board has ⇒ zero events, honestly counted.
    // Never widened back open behind the caller's back.
    const nothing = await fetchNotifications({ taskType: "Waterfall" });
    expect(nothing.count).toBe(0);
    expect(nothing.filteredCount).toBe(2);
  });

  it("a client filter suppresses delivery on the REAL board, honestly counted, cursor pinned", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    await runCli(["tasks", "--add", "--title", "client filter fixture", "--json"]);
    await runCli([
      "tasks",
      "--edit",
      (await fetchNotifications()).notifications[0]!.taskId,
      "--set-status",
      "in-progress",
      "--comment",
      "client filter me",
      "--json",
    ]);
    const window = await fetchNotifications();
    expect(window.count).toBe(3);

    // The CLIENT serialises the filter onto the served route (waitMs forces
    // the HTTP path — `longPoll` in the answer proves the BOARD answered it,
    // not the file fallback): only the comment is delivered, the other two
    // events are dropped AND counted, and nextTs is pinned behind the
    // OLDEST drop.
    const filtered = await readViaClient(projectDir, {
      target: "local",
      filter: { type: ["task.comment"] },
      waitMs: 50,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.longPoll).toBeDefined();
    expect(
      filtered.notifications.map((e) => (e as { type: string }).type),
    ).toEqual(["task.comment"]);
    expect(filtered.count).toBe(1);
    expect(filtered.filteredCount).toBe(2);
    expect(filtered.nextTs).toBe(window.notifications[0]!.ts);

    // The cursor NEVER regressed over the suppressed events: re-reading from
    // where it stopped, unfiltered, still delivers every one of them.
    const widened = await readViaClient(projectDir, {
      target: "local",
      since: filtered.nextTs!,
      waitMs: 50,
    });
    expect(widened.ok).toBe(true);
    if (!widened.ok) return;
    expect(widened.notifications.map((e) => (e as { id: string }).id)).toEqual(
      window.notifications.map((e) => e.id),
    );

    // OR through the client on the real route: create or comment matches,
    // the update is the one drop.
    const either = await readViaClient(projectDir, {
      target: "local",
      filter: { type: ["task.create", "task.comment"] },
      waitMs: 50,
    });
    expect(either.ok).toBe(true);
    if (!either.ok) return;
    expect(either.count).toBe(2);
    expect(either.filteredCount).toBe(1);
  });


  it("holds a read open and wakes it on the next append", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    await runCli(["tasks", "--add", "--title", "held read task", "--json"]);
    const seed = await fetchNotifications();

    // The write arrives from ANOTHER process while the read is held — the case
    // an in-process board broadcast would miss, and the reason the signal is a
    // file watch.
    const held = fetchNotifications({ since: seed.nextTs!, wait: 5_000 });
    // Let the request reach the board and arm its hold before the append.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runCli([
      "tasks",
      "--edit",
      seed.notifications[0]!.taskId,
      "--set-status",
      "in-progress",
      "--json",
    ]);
    const answer = await held;

    // An explicit `event` release: the follower learns it was WOKEN, not that
    // it happened to ask at the right moment.
    expect(answer.wait).toEqual({ boundMs: 5_000, released: "event" });
    expect(answer.notifications.map((event) => event.type)).toContain(
      "task.update",
    );
  });

  it("a wait that expires answers an empty page, not a gap", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    await runCli(["tasks", "--add", "--title", "quiet task", "--json"]);
    const seed = await fetchNotifications();
    const timedOut = await fetchNotifications({
      since: seed.nextTs!,
      wait: 150,
    });

    // The boundary event sits ON the cursor, so a plain read would return it.
    // A held read that expires returns NOTHING and says nothing was lost.
    expect(timedOut.notifications).toEqual([]);
    expect(timedOut.count).toBe(0);
    expect(timedOut.truncated).toBe(false);
    expect(timedOut.nextTs).toBe(seed.nextTs);
    expect(timedOut.gap).toBe(false);
    expect(timedOut.wait).toEqual({ boundMs: 150, released: "timeout" });
  });

  it("rejects a `wait` that is not a whole number of milliseconds", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });
    const response = await fetch(`${instance.url}/api/notifications?wait=soon`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      code: string;
      details: { expectedFormat: string; example: string };
    };
    expect(Object.keys(body).sort()).toEqual(["code", "details", "error"]);
    expect(body.code).toBe("INVALID_WAIT");
    expect(body.details.expectedFormat).toBe("<milliseconds, digits only>");
    expect(body.details.example).toContain("wait=");
    expect(body.error).toContain("milliseconds");
  });

  it("rejects a filter value no stored event could ever hold", async () => {
    instance = await serveWithPort(undefined, {
      open: false,
      projectDir,
      _testToken: null,
      _testWorkspace: null,
    });

    const response = await fetch(
      `${instance.url}/api/notifications?taskId=${encodeURIComponent("a\u0000b")}`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      code: string;
      details: { dimension: string; expectedFormat: string; example: string };
    };
    // The SAME envelope as INVALID_SINCE — and as the hosted route (ticket
    // 0045949e phase 1): the dimension that failed rides in `details`, so a
    // client branches on `code` and never parses the sentence.
    expect(Object.keys(body).sort()).toEqual(["code", "details", "error"]);
    expect(body.code).toBe("INVALID_FILTER");
    expect(body.details.dimension).toBe("taskId");
    expect(body.error).toContain("taskId");
    expect(body.details.expectedFormat).toContain("taskId=");
    expect(body.details.example).toContain("taskId=");
  });
});
