/**
 * Local notification log (ticket ecba6126): append / read round-trip, the
 * inclusive `since` token, the newest-N paging with its clamp, the 500-event
 * trim with its `gap` warning, tolerant parsing, the kill switch, and the
 * best-effort promise that a notification never throws.
 *
 * The unit setup pins `VIBEFLOW_EVENTS=0`; the env-sensitive cases here opt
 * back in explicitly (argument for the predicate, per-case `process.env` for
 * the default read) — nothing here depends on the developer's shell.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendConfirmedNotification,
  appendNotification,
  isOwnNotification,
  isValidNotificationFilterValue,
  NOTIFICATION_FILTER_MAX_LENGTH,
  notificationStatusOf,
  newNotificationId,
  notificationFromActivity,
  notificationIdentity,
  notificationsEnabled,
  notificationsFromConfirmed,
  notificationsEpochPath,
  notificationsPath,
  readNotifications,
  type NotificationEvent,
  type NotificationExtras,
  type NotificationFilter,
} from "../../src/core/notifications.js";
import type {
  HookActivity,
  HookConfirmedPayloads,
} from "../../src/core/hooks/activities.js";
import { emitAfterHook } from "../../src/core/hooks/emit.js";
import {
  beginToolInvocation,
  finishToolInvocation,
} from "../../src/core/hooks/invocation.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "vf-notifications-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** An event with stable, caller-controlled identity and timestamp. */
function event(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: newNotificationId(),
    ts: "2026-01-01T00:00:00.000Z",
    type: "task.update",
    taskId: "abc12345",
    actor: "agent",
    ...over,
  };
}

/** The stored file's non-empty lines — the on-disk shape a reader sees. */
function storedLines(): string[] {
  return readFileSync(notificationsPath(projectDir), "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

describe("newNotificationId", () => {
  it("mints evt_ + 26 lowercase base32 chars, unique per call", () => {
    const first = newNotificationId();
    const second = newNotificationId();
    expect(first).toMatch(/^evt_[a-z2-7]{26}$/);
    expect(second).toMatch(/^evt_[a-z2-7]{26}$/);
    expect(first).not.toBe(second);
  });
});

describe("notificationsPath", () => {
  it("is <projectDir>/.vibeflow/notifications.jsonl", () => {
    expect(notificationsPath(projectDir)).toBe(
      join(projectDir, ".vibeflow", "notifications.jsonl"),
    );
  });
});

/**
 * chmod is advisory for uid 0 — the unwritable-project case is unprovable as
 * root, so it is SKIPPED (reported as skipped, not silently passing).
 */
const runningAsRoot = process.getuid?.() === 0;

describe("appendNotification + readNotifications", () => {
  it("round-trips events in append order, one JSON line each", () => {
    const first = event({ ts: "2026-01-01T00:00:00.000Z", taskId: "aaa11111" });
    const second = event({
      ts: "2026-01-01T00:00:01.000Z",
      taskId: "bbb22222",
      type: "task.create",
      changed: ["status"],
      to: { status: "todo" },
    });
    appendNotification(projectDir, first);
    appendNotification(projectDir, second);

    const lines = storedLines();
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line) as NotificationEvent)).toEqual([
      first,
      second,
    ]);

    const read = readNotifications(projectDir);
    expect(read.notifications).toEqual([first, second]);
    expect(read.count).toBe(2);
    expect(read.nextTs).toBe(second.ts);
    expect(read.earliestTs).toBe(first.ts);
    expect(read.gap).toBe(false);
    expect(read.truncated).toBe(false);
  });

  it("starts from an absent log as an empty page", () => {
    const read = readNotifications(projectDir);
    expect(read).toEqual({
      notifications: [],
      nextTs: null,
      earliestTs: null,
      gap: false,
      truncated: false,
      count: 0,
      filteredCount: 0,
    });
  });

  it("`since` is inclusive: the boundary event is returned, older ones are not", () => {
    const older = event({ ts: "2026-01-01T00:00:00.000Z", taskId: "aaa11111" });
    const boundary = event({
      ts: "2026-01-01T00:00:10.000Z",
      taskId: "bbb22222",
    });
    const newer = event({ ts: "2026-01-01T00:00:20.000Z", taskId: "ccc33333" });
    for (const e of [older, boundary, newer]) appendNotification(projectDir, e);

    // Exactly at the boundary: the boundary event itself comes back.
    const fromBoundary = readNotifications(projectDir, { since: boundary.ts });
    expect(fromBoundary.notifications).toEqual([boundary, newer]);
    expect(fromBoundary.count).toBe(2);

    // Past the boundary event, it drops out; the newer one stays.
    const pastBoundary = readNotifications(projectDir, {
      since: "2026-01-01T00:00:15.000Z",
    });
    expect(pastBoundary.notifications).toEqual([newer]);

    // Nothing newer: the caller's token is echoed back so it can poll again.
    const fromNewest = readNotifications(projectDir, { since: newer.ts });
    expect(fromNewest.count).toBe(1);
    const afterNewest = readNotifications(projectDir, {
      since: "2026-12-31T00:00:00.000Z",
    });
    expect(afterNewest.notifications).toEqual([]);
    expect(afterNewest.nextTs).toBe("2026-12-31T00:00:00.000Z");
  });

  it("normalises an offset/date-shaped `since` before comparing", () => {
    // Regression guard for the lexical comparison: `2026-11-22T10:00:00.000Z`
    // and `2026-11-22T12:00:00+02:00` are the SAME instant, but as plain
    // strings the offset form sorts later → the boundary event used to be
    // skipped. Same instant must return it (inclusive), one ms later must not.
    const at = event({ ts: "2026-11-22T10:00:00.000Z" });
    const later = event({ ts: "2026-11-22T10:00:01.000Z" });
    appendNotification(projectDir, at);
    appendNotification(projectDir, later);

    const sameInstant = readNotifications(projectDir, {
      since: "2026-11-22T12:00:00+02:00",
    });
    expect(sameInstant.notifications).toEqual([at, later]);

    const oneMsLater = readNotifications(projectDir, {
      since: "2026-11-22T12:00:00.001+02:00",
    });
    expect(oneMsLater.notifications).toEqual([later]);

    // A date-only token is midnight UTC, not a lexical prefix.
    const fromMidnight = readNotifications(projectDir, { since: "2026-11-22" });
    expect(fromMidnight.notifications).toEqual([at, later]);
  });

  it("`limit` keeps the NEWEST matches and reports truncation", () => {
    const all = Array.from({ length: 5 }, (_, i) =>
      event({
        ts: `2026-01-01T00:00:0${i}.000Z`,
        taskId: `task000${i}`,
      }),
    );
    for (const e of all) appendNotification(projectDir, e);

    const page = readNotifications(projectDir, { limit: 2 });
    expect(page.notifications).toEqual([all[3], all[4]]);
    expect(page.count).toBe(2);
    expect(page.truncated).toBe(true);
    // oldest stored is untouched by paging — it is a property of the FILE.
    expect(page.earliestTs).toBe(all[0]!.ts);

    const exact = readNotifications(projectDir, { limit: 5 });
    expect(exact.count).toBe(5);
    expect(exact.truncated).toBe(false);
  });

  it("defaults the page to the newest 50 events", () => {
    for (let i = 0; i < 60; i++) {
      appendNotification(
        projectDir,
        event({ ts: new Date(1_767_225_600_000 + i * 1000).toISOString() }),
      );
    }
    const page = readNotifications(projectDir);
    expect(page.count).toBe(50);
    expect(page.truncated).toBe(true);
  });

  it("clamps `limit` to 200 and treats a non-positive limit as the default", () => {
    for (let i = 0; i < 210; i++) {
      appendNotification(
        projectDir,
        event({ ts: new Date(1_767_225_600_000 + i * 1000).toISOString() }),
      );
    }
    const clamped = readNotifications(projectDir, { limit: 1000 });
    expect(clamped.count).toBe(200);
    expect(clamped.truncated).toBe(true);

    const zero = readNotifications(projectDir, { limit: 0 });
    expect(zero.count).toBe(50);
  });

  it("trims to the last 500 events and reports the eviction as a gap", () => {
    const all = Array.from({ length: 510 }, (_, i) =>
      event({
        ts: new Date(1_767_225_600_000 + i * 1000).toISOString(),
        taskId: `task${i}`,
      }),
    );
    for (const e of all) appendNotification(projectDir, e);

    const lines = storedLines();
    expect(lines).toHaveLength(500);
    const survivor = all[all.length - 500]!;
    expect(JSON.parse(lines[0]!) as NotificationEvent).toEqual(survivor);
    // The evicted ones are GONE from disk, not merely unread.
    expect(lines.some((line) => line.includes('"taskId":"task0"'))).toBe(false);

    const read = readNotifications(projectDir, { limit: 200 });
    expect(read.earliestTs).toBe(survivor.ts);
    expect(read.gap).toBe(false);

    // A cursor older than the oldest survivor means the caller missed events.
    const stale = readNotifications(projectDir, { since: all[0]!.ts });
    expect(stale.gap).toBe(true);
    expect(stale.earliestTs).toBe(survivor.ts);
  });

  it("reports a DESTROYED log as a gap, not as silence (ticket t3og1r0u)", () => {
    // The local twin of the hosted ring's "restart emptied the ring" warning.
    // Before this, a follower holding a cursor against a deleted log was handed
    // an empty page and told nothing had been lost, so it advanced past events
    // that no longer existed. The epoch marker is what makes the two cases
    // distinguishable — see `notificationsEpochPath`.
    const kept = event({ taskId: "kept0001" });
    appendNotification(projectDir, kept);
    expect(readNotifications(projectDir, { since: kept.ts }).gap).toBe(false);

    // Someone cleared the log (a reset, a bad script, a fresh clone) while the
    // follower kept its cursor.
    writeFileSync(notificationsPath(projectDir), "", "utf-8");

    const destroyed = readNotifications(projectDir, { since: kept.ts });
    expect(destroyed.gap).toBe(true);
    expect(destroyed.earliestTs).toBeNull();
    // Serious enough to be visible in the payload, not only in a boolean.
    expect(destroyed.count).toBe(0);
  });

  it("does NOT warn about a fresh project that was simply never written", () => {
    // No events, no marker: nothing was lost, so a `since` cursor must not
    // invent a gap. This is the case the hosted ring cannot distinguish, and
    // the reason the two backends deliberately differ here.
    const fresh = readNotifications(projectDir, {
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(fresh.gap).toBe(false);
    expect(fresh.earliestTs).toBeNull();
    expect(existsSync(notificationsEpochPath(projectDir))).toBe(false);
  });

  it("keeps the marker across a reset, so the warning survives a second look", () => {
    appendNotification(projectDir, event({ taskId: "once0001" }));
    expect(existsSync(notificationsEpochPath(projectDir))).toBe(true);
    writeFileSync(notificationsPath(projectDir), "", "utf-8");
    expect(readNotifications(projectDir, { since: "2026-01-01T00:00:00.000Z" }).gap).toBe(true);
    // Reading must not consume or recreate anything.
    expect(existsSync(notificationsEpochPath(projectDir))).toBe(true);
    expect(readNotifications(projectDir, { since: "2026-01-01T00:00:00.000Z" }).gap).toBe(true);
  });

  it("skips malformed and blank lines instead of failing the read", () => {
    const good = event({ taskId: "good1111" });
    mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
    writeFileSync(
      notificationsPath(projectDir),
      [
        "",
        "   ",
        "not json at all",
        JSON.stringify(good),
        '{"id":"evt_truncated"',
        JSON.stringify({ hello: "world" }),
        JSON.stringify(event({ taskId: "good2222" })),
        "",
      ].join("\n"),
      "utf-8",
    );

    const read = readNotifications(projectDir);
    expect(read.notifications.map((e) => e.taskId)).toEqual([
      "good1111",
      "good2222",
    ]);
    expect(read.count).toBe(2);
  });

  it.skipIf(runningAsRoot)(
    "never throws when the project directory is unwritable",
    () => {
      chmodSync(projectDir, 0o500);
      try {
        expect(() => appendNotification(projectDir, event())).not.toThrow();
      } finally {
        chmodSync(projectDir, 0o700);
      }
    },
  );
});

describe("notificationsEnabled", () => {
  it("is off only for VIBEFLOW_EVENTS=0", () => {
    expect(notificationsEnabled({})).toBe(true);
    expect(notificationsEnabled({ VIBEFLOW_EVENTS: "1" })).toBe(true);
    expect(notificationsEnabled({ VIBEFLOW_EVENTS: "" })).toBe(true);
    expect(notificationsEnabled({ VIBEFLOW_EVENTS: "0" })).toBe(false);
  });

  it("reads process.env by default (the kill switch tests rely on it)", () => {
    const previous = process.env.VIBEFLOW_EVENTS;
    try {
      process.env.VIBEFLOW_EVENTS = "0";
      expect(notificationsEnabled()).toBe(false);
      process.env.VIBEFLOW_EVENTS = "1";
      expect(notificationsEnabled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.VIBEFLOW_EVENTS;
      else process.env.VIBEFLOW_EVENTS = previous;
    }
  });
});

/**
 * The projection (ticket ecba6126): a notification is derived from the SAME
 * `HookActivity` + `HookConfirmedPayloads` pair the after-hook narrates, so
 * the vocabulary has ONE source and the table below is the whole of it.
 * `extras` carries identity the boundary supplies; pinning `id`/`ts` is what
 * makes each row assert the EXACT event rather than "roughly this".
 */
const FIXED = {
  actor: "agent",
  ts: "2026-01-01T00:00:00.000Z",
  id: "evt_aaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

const EXTRAS: NotificationExtras = FIXED;

type ProjectionRow<A extends HookActivity> = {
  payload: HookConfirmedPayloads[A];
  expected: NotificationEvent | null;
};

/** One row per activity. A new activity is a TYPE error here (see below). */
const PROJECTION_ROWS: { [A in HookActivity]: ProjectionRow<A> } = {
  "task.create": {
    payload: {
      task: { id: "aaa11111", title: "Fix it", status: "todo", type: "bug" },
    },
    expected: {
      id: FIXED.id,
      ts: FIXED.ts,
      type: "task.create",
      taskId: "aaa11111",
      actor: "agent",
      to: { status: "todo", type: "bug" },
    },
  },
  "task.update": {
    payload: { taskId: "bbb22222", changed: ["status", "author"] },
    expected: {
      id: FIXED.id,
      ts: FIXED.ts,
      type: "task.update",
      taskId: "bbb22222",
      actor: "agent",
      changed: ["status", "author"],
    },
  },
  "task.claim": {
    payload: { taskId: "ccc33333", from: "todo", to: "in-progress" },
    expected: {
      id: FIXED.id,
      ts: FIXED.ts,
      type: "task.claim",
      taskId: "ccc33333",
      actor: "agent",
      changed: ["status"],
      to: { from: "todo", to: "in-progress" },
    },
  },
  "task.delete": {
    payload: { taskId: "ddd44444", childCount: 2 },
    expected: {
      id: FIXED.id,
      ts: FIXED.ts,
      type: "task.delete",
      taskId: "ddd44444",
      actor: "agent",
      to: { childCount: 2 },
    },
  },
  "task.comment": {
    payload: { taskId: "eee55555", commentId: "cmt_00000001" },
    expected: {
      id: FIXED.id,
      ts: FIXED.ts,
      type: "task.comment",
      taskId: "eee55555",
      actor: "agent",
      to: { commentId: "cmt_00000001" },
    },
  },
  verify: {
    payload: { taskId: "fff66666", verdict: "pass" },
    expected: {
      id: FIXED.id,
      ts: FIXED.ts,
      type: "verify",
      taskId: "fff66666",
      actor: "agent",
      to: { verdict: "pass" },
    },
  },
  // No task id ⇒ nothing to resolve with `tasks --get <id>`: no event.
  push: {
    payload: { taskCount: 3, chunkCount: 1, transport: "https" },
    expected: null,
  },
  pull: {
    payload: { written: 2, skipped: 0, mode: "fast-forward" },
    expected: null,
  },
};

/**
 * Marker: the row table covers every activity the vocabulary declares. This
 * is the `satisfies` that fails the BUILD (not a test) when a ninth activity
 * is added — the same guarantee `PROJECTIONS` gives the implementation.
 */
const ACTIVITIES = {
  "task.create": true,
  "task.update": true,
  "task.claim": true,
  "task.delete": true,
  "task.comment": true,
  push: true,
  pull: true,
  verify: true,
} satisfies Record<HookActivity, true>;

describe("notificationFromActivity", () => {
  it.each(Object.keys(ACTIVITIES) as HookActivity[])(
    "projects %s onto its one event (or null)",
    (activity) => {
      const row = PROJECTION_ROWS[activity];
      expect(notificationFromActivity(activity, row.payload, EXTRAS)).toEqual(
        row.expected,
      );
    },
  );

  it("covers every declared activity exactly once", () => {
    expect(new Set(Object.keys(PROJECTION_ROWS))).toEqual(
      new Set(Object.keys(ACTIVITIES)),
    );
  });

  it("projects EVERY confirmed effect of one invocation, not just the last", () => {
    // `--edit --set-status X --comment "…"` confirms two effects. Reporting
    // only the last would tell an agent about the comment and hide that the
    // status moved — the reason the boundary emits one event per effect.
    const events = notificationsFromConfirmed(
      [
        {
          activity: "task.update",
          payload: { taskId: "aaa11111", changed: ["status"] },
        },
        {
          activity: "task.comment",
          payload: { taskId: "aaa11111", commentId: "cmt-1" },
        },
      ],
      // No fixed id in the extras: each event mints its own.
      { actor: "agent" },
    );
    expect(events.map((event) => event.type)).toEqual([
      "task.update",
      "task.comment",
    ]);
    expect(events[0]?.changed).toEqual(["status"]);
    expect(events[1]?.to).toEqual({ commentId: "cmt-1" });
    // Same task, two events, distinct ids — the feed is not a per-task map.
    expect(events[0]?.id).not.toBe(events[1]?.id);
  });

  it("drops a metadata-only update instead of emitting noise", () => {
    // A comment-only edit touches `updatedAt` and reports itself through
    // `task.comment`; a bare `task.update (updatedAt)` beside it is noise that
    // teaches a consumer to ignore the feed.
    expect(
      notificationFromActivity(
        "task.update",
        { taskId: "aaa11111", changed: ["updatedAt", "sortKey"] },
        EXTRAS,
      ),
    ).toBeNull();
    // A real field survives, and the bookkeeping keys are stripped with it.
    expect(
      notificationFromActivity(
        "task.update",
        { taskId: "aaa11111", changed: ["updatedAt", "status"] },
        EXTRAS,
      )?.changed,
    ).toEqual(["status"]);
  });

  it("drops effects that are not actionable (push/pull carry no task id)", () => {
    const events = notificationsFromConfirmed(
      [
        {
          activity: "push",
          payload: { taskCount: 2, chunkCount: 1, transport: "https" },
        },
        { activity: "pull", payload: { written: 3, skipped: 0, mode: "merge" } },
      ],
      EXTRAS,
    );
    expect(events).toEqual([]);
  });

  it("omits `type` from a create's `to` when the task carries none", () => {
    const event = notificationFromActivity(
      "task.create",
      { task: { id: "ggg77777", title: "Plain", status: "todo" } },
      EXTRAS,
    );
    expect(event?.to).toEqual({ status: "todo" });
  });

  it("mints id + ts and takes the actor from the caller when absent", () => {
    const event = notificationFromActivity(
      "task.delete",
      { taskId: "ddd44444", childCount: 0 },
      { actor: "board" },
    );
    expect(event).not.toBeNull();
    expect(event!.id).toMatch(/^evt_[a-z2-7]{26}$/);
    expect(new Date(event!.ts).toISOString()).toBe(event!.ts);
    expect(event!.actor).toBe("board");
  });
});

/**
 * The capture the projection depends on (ticket ecba6126). `VIBEFLOW_HOOKS=0`
 * is the SUITE DEFAULT (tests/setup/disable-telemetry.ts) — the point of this
 * case is that a mutation still produces its event with hooks disabled: the
 * emitter records the confirmed effect BEFORE the hooks-off early return, so
 * narration being off can never make a write invisible to the feed.
 */
describe("confirmed capture → projection (hooks disabled)", () => {
  it("records the edit's confirmed effect and survives the finish", async () => {
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };

    const instructions = await emitAfterHook(
      { projectDir, mode: "local" },
      handle.scope,
      "task.update",
      { taskId: "abc12345", changed: ["status", "author"] },
      { env: { VIBEFLOW_HOOKS: "0" } },
    );
    // Hooks are OFF: nothing ran, yet the effect was captured.
    expect(instructions).toEqual([]);

    const confirmed = handle.confirmed;
    expect(confirmed).toEqual([
      {
        activity: "task.update",
        payload: { taskId: "abc12345", changed: ["status", "author"] },
      },
    ]);
    const effect = confirmed[0];
    if (effect === undefined) throw new Error("confirmed effect not captured");

    // The boundary reads it AFTER the finish — the finish must not clear it.
    await finishToolInvocation(handle, { ok: true });
    expect(handle.confirmed).toEqual(confirmed);

    const event = notificationFromActivity(
      effect.activity,
      effect.payload,
      { actor: "agent" },
    );
    expect(event).not.toBeNull();
    if (event === null) throw new Error("task.update must project an event");
    appendNotification(projectDir, event);

    const read = readNotifications(projectDir);
    expect(read.notifications.map((e) => [e.type, e.taskId])).toEqual([
      ["task.update", "abc12345"],
    ]);
  });

  it("keeps EVERY confirmed effect when one action fires twice", async () => {
    const handle = beginToolInvocation({ tool: "tasks", surface: "cli" });
    handle.target = { projectDir, mode: "local" };
    const opts = { env: { VIBEFLOW_HOOKS: "0" } };

    await emitAfterHook(
      { projectDir, mode: "local" },
      handle.scope,
      "task.update",
      { taskId: "abc12345", changed: ["status"] },
      opts,
    );
    await emitAfterHook(
      { projectDir, mode: "local" },
      handle.scope,
      "task.comment",
      { taskId: "abc12345", commentId: "cmt_00000002" },
      opts,
    );

    // Two effects, two events: the comment was the LAST thing confirmed, but
    // dropping the earlier `task.update` would hide that the status moved.
    const confirmed = handle.confirmed;
    expect(confirmed.map((effect) => effect.activity)).toEqual([
      "task.update",
      "task.comment",
    ]);
    expect(confirmed[1]?.payload).toEqual({
      taskId: "abc12345",
      commentId: "cmt_00000002",
    });
    expect(
      notificationsFromConfirmed(confirmed, { actor: "agent" }).map(
        (event) => event.type,
      ),
    ).toEqual(["task.update", "task.comment"]);
  });
});

/**
 * Explicit agent identity (ticket kzxaq0fd): `$VIBEFLOW_ACTOR` is the only
 * identity a follower may suppress on. The event's `agent` is a separate field
 * from `actor` because `actor` falls back to the shared "agent" default —
 * which cannot tell two agents apart — and because the hosted `actor` is the
 * credential owner (a user id shared by every agent on the PAT).
 */
describe("notificationIdentity", () => {
  it("names the explicit $VIBEFLOW_ACTOR as BOTH actor and agent", () => {
    expect(notificationIdentity({ VIBEFLOW_ACTOR: "  pi-a  " })).toEqual({
      actor: "pi-a",
      agent: "pi-a",
    });
  });

  it("keeps the historical 'agent' actor but stamps NO agent when unset", () => {
    const identity = notificationIdentity({});
    expect(identity.actor).toBe("agent");
    // The absence is load-bearing: stamping the shared default as `agent`
    // would make every unidentified follower suppress every other's events.
    expect(identity).not.toHaveProperty("agent");
  });

  it("treats a blank or whitespace-only value as unset", () => {
    for (const VIBEFLOW_ACTOR of ["", "   "]) {
      const identity = notificationIdentity({ VIBEFLOW_ACTOR });
      expect(identity.actor).toBe("agent");
      expect(identity).not.toHaveProperty("agent");
    }
  });

  it("carries the agent through the projection (a consumer can decide)", () => {
    const event = notificationFromActivity(
      "task.comment",
      { taskId: "abc12345", commentId: "cmt-1" },
      notificationIdentity({ VIBEFLOW_ACTOR: "pi-a" }),
    );
    expect(event).toMatchObject({ actor: "pi-a", agent: "pi-a" });
  });
});

/**
 * The follower's delivery filter (ticket kzxaq0fd): suppress only an event
 * this follower's own agent caused. Peer and unknown identity must pass —
 * silence may never come from an identity nobody declared.
 */
describe("isOwnNotification", () => {
  const own = { type: "task.comment", taskId: "t1", actor: "user-1", agent: "pi-a" };

  it("suppresses a self-authored event when the identity matches", () => {
    expect(isOwnNotification(own, "pi-a")).toBe(true);
  });

  it("delivers a peer's event (different declared agent)", () => {
    expect(isOwnNotification(own, "pi-b")).toBe(false);
  });

  it("delivers an event with NO agent (human/board write or old event)", () => {
    expect(
      isOwnNotification({ type: "task.update", taskId: "t1", actor: "board" }, "pi-a"),
    ).toBe(false);
  });

  it("never suppresses without an explicit self identity — the residual", () => {
    // Without VIBEFLOW_ACTOR there is no own identity to match, so the
    // follower still receives its own writes. Documented, not silent.
    expect(isOwnNotification(own, undefined)).toBe(false);
    expect(isOwnNotification(own, "")).toBe(false);
  });

  it("ignores a malformed event instead of throwing", () => {
    expect(isOwnNotification(null, "pi-a")).toBe(false);
    expect(isOwnNotification({ agent: 42 }, "pi-a")).toBe(false);
  });
});

/**
 * The ONE append seam the CLI boundary and the board routes share (ticket
 * mzxp8u98): the event is the projection of a confirmed payload, never a
 * second description. The kill switch is owned by the seam so a caller cannot
 * forget it.
 */
describe("appendConfirmedNotification", () => {
  const savedEvents = process.env.VIBEFLOW_EVENTS;

  beforeEach(() => {
    process.env.VIBEFLOW_EVENTS = "1";
  });

  afterEach(() => {
    if (savedEvents === undefined) delete process.env.VIBEFLOW_EVENTS;
    else process.env.VIBEFLOW_EVENTS = savedEvents;
  });

  it("appends exactly one event for one confirmed effect, agent preserved", () => {
    const written = appendConfirmedNotification(
      projectDir,
      {
        activity: "task.comment",
        payload: { taskId: "abc12345", commentId: "cmt-1" },
      },
      { actor: "board" },
    );

    expect(written).toMatchObject({
      type: "task.comment",
      taskId: "abc12345",
      actor: "board",
      to: { commentId: "cmt-1" },
    });
    const read = readNotifications(projectDir);
    expect(read.count).toBe(1);
    // A board write names no agent: it is never "self" for a follower.
    expect(read.notifications[0]).not.toHaveProperty("agent");
  });

  it("round-trips an explicit agent through the JSONL store", () => {
    appendConfirmedNotification(
      projectDir,
      { activity: "task.update", payload: { taskId: "abc12345", changed: ["status"] } },
      { actor: "pi-a", agent: "pi-a" },
    );
    const read = readNotifications(projectDir);
    expect(read.notifications[0]).toMatchObject({
      type: "task.update",
      agent: "pi-a",
      changed: ["status"],
    });
  });

  it("writes nothing when VIBEFLOW_EVENTS=0 (the seam owns the switch)", () => {
    process.env.VIBEFLOW_EVENTS = "0";
    expect(
      appendConfirmedNotification(
        projectDir,
        { activity: "task.comment", payload: { taskId: "abc12345", commentId: "c" } },
        { actor: "board" },
      ),
    ).toBeNull();
    expect(readNotifications(projectDir).count).toBe(0);
  });

  it("drops a bookkeeping-only update (the existing rule still holds)", () => {
    expect(
      appendConfirmedNotification(
        projectDir,
        { activity: "task.update", payload: { taskId: "abc12345", changed: ["sortKey"] } },
        { actor: "board" },
      ),
    ).toBeNull();
    expect(readNotifications(projectDir).count).toBe(0);
  });
});

/**
 * Subscription dimensions + the honest `filteredCount` (ticket p3tkodry).
 *
 * Three properties, in the order they can go wrong:
 * - only matches are returned, and every dropped event is COUNTED, so a
 *   filtered follower always learns that something was filtered (counts, never
 *   silence);
 * - a dimension this store does not know WIDENS (ignoring it can only return
 *   more), while a known dimension with an impossible-to-store value is the
 *   route's 400 — never a silent reinterpretation;
 * - `nextTs` never advances past a dropped event, so changing the filter later
 *   still reaches it. This is the subtle half: a cursor is not "the last event
 *   in the page", it is the point up to which the caller has accounted for
 *   EVERYTHING.
 */
describe("readNotifications — subscription filters", () => {
  /** create(a), comment(a), create(b) — one per dimension worth matching. */
  function seedBoard(): void {
    appendNotification(
      projectDir,
      event({
        ts: "2026-01-01T00:00:00.000Z",
        type: "task.create",
        taskId: "task-a",
        to: { status: "todo" },
      }),
    );
    appendNotification(
      projectDir,
      event({
        ts: "2026-01-01T00:00:10.000Z",
        type: "task.comment",
        taskId: "task-a",
        agent: "pi-a",
        to: { commentId: "cmt-1" },
      }),
    );
    appendNotification(
      projectDir,
      event({
        ts: "2026-01-01T00:00:20.000Z",
        type: "task.create",
        taskId: "task-b",
        to: { status: "in-progress" },
      }),
    );
  }

  it("returns only the matches and counts every dropped event", () => {
    seedBoard();

    const read = readNotifications(projectDir, { filter: { taskId: "task-a" } });

    expect(read.notifications.map((e) => e.type)).toEqual([
      "task.create",
      "task.comment",
    ]);
    expect(read.count).toBe(2);
    // 3 in the window, 2 matched — the follower is TOLD, not silently shorted.
    expect(read.filteredCount).toBe(1);
  });

  it("counts nothing as filtered when the filter is absent (the old answer)", () => {
    seedBoard();
    const read = readNotifications(projectDir);
    expect(read.count).toBe(3);
    expect(read.filteredCount).toBe(0);
    expect(read.nextTs).toBe("2026-01-01T00:00:20.000Z");
  });

  it("ANDs the dimensions — a match must satisfy every one of them", () => {
    seedBoard();

    const both = readNotifications(projectDir, {
      filter: { taskId: "task-a", type: "task.comment" },
    });
    expect(both.notifications.map((e) => e.type)).toEqual(["task.comment"]);
    expect(both.filteredCount).toBe(2);

    const impossible = readNotifications(projectDir, {
      filter: { taskId: "task-a", type: "task.create" },
    });
    expect(impossible.count).toBe(1);
    expect(impossible.filteredCount).toBe(2);
  });

  it("reads `status` from a create's to.status and a claim's to.to", () => {
    appendNotification(
      projectDir,
      event({ ts: "2026-01-01T00:00:00.000Z", type: "task.create", to: { status: "todo" } }),
    );
    appendNotification(
      projectDir,
      event({
        ts: "2026-01-01T00:00:10.000Z",
        type: "task.claim",
        // task.claim names its destination as `to.to` ({from, to}).
        to: { from: "todo", to: "in-progress" },
      }),
    );
    // A local task.update carries only the changed KEYS, so it has no status
    // to match — the documented edge (the hosted twin does carry values).
    appendNotification(
      projectDir,
      event({ ts: "2026-01-01T00:00:20.000Z", type: "task.update", changed: ["status"] }),
    );

    const claimed = readNotifications(projectDir, {
      filter: { status: "in-progress" },
    });
    expect(claimed.notifications.map((e) => e.type)).toEqual(["task.claim"]);
    expect(claimed.filteredCount).toBe(2);
    // An event with no status at all never satisfies a status filter.
    expect(notificationStatusOf(event({ type: "task.update" }))).toBeUndefined();
  });

  it("matches `agent` only on an event that NAMES that agent", () => {
    seedBoard();
    const read = readNotifications(projectDir, { filter: { agent: "pi-a" } });
    expect(read.notifications).toHaveLength(1);
    expect(read.notifications[0]!.type).toBe("task.comment");
    // An unnamed event is not "pi-a": naming a writer must never select the
    // writes nobody claimed.
    expect(read.filteredCount).toBe(2);
  });

  it("WIDENS on a dimension this store does not know", () => {
    seedBoard();

    // A newer client's dimension on an older store: ignoring it returns MORE
    // than asked for. Narrowing (or throwing) would hide events.
    const read = readNotifications(projectDir, {
      filter: { tag: "urgent", taskId: "task-a" } as NotificationFilter,
    });

    expect(read.count).toBe(2);
    expect(read.filteredCount).toBe(1);
  });

  it("treats an empty or blank dimension value as no constraint", () => {
    seedBoard();
    const read = readNotifications(projectDir, {
      filter: { taskId: "", type: "   ", agent: undefined },
    });
    expect(read.count).toBe(3);
    expect(read.filteredCount).toBe(0);
  });

  it("drops BEFORE the page size: a filtered event cannot crowd out a match", () => {
    seedBoard();
    // limit 1 with the newest two filtered: the answer is the one match, not
    // an empty page (paging happens over the matches, never over the window).
    const read = readNotifications(projectDir, {
      limit: 1,
      filter: { taskId: "task-a" },
    });
    expect(read.notifications.map((e) => e.taskId)).toEqual(["task-a"]);
    expect(read.truncated).toBe(true);
    expect(read.filteredCount).toBe(1);
  });

  it("pins nextTs at the oldest dropped event so a later filter still sees it", () => {
    seedBoard();

    // Filter away the OLDEST event; the newest two still come back.
    const filtered = readNotifications(projectDir, {
      filter: { type: "task.comment" },
    });
    expect(filtered.notifications.map((e) => e.type)).toEqual(["task.comment"]);
    expect(filtered.filteredCount).toBe(2);
    // NOT 00:00:10 (the last match): the two dropped events are behind us only
    // if we are willing to forget them — so the cursor stays before them.
    expect(filtered.nextTs).toBe("2026-01-01T00:00:00.000Z");

    // The follower obeys the cursor, then drops its filter: the events it had
    // filtered out are still ahead of it and ARE delivered.
    const widened = readNotifications(projectDir, { since: filtered.nextTs! });
    expect(widened.notifications.map((e) => e.taskId)).toEqual([
      "task-a",
      "task-a",
      "task-b",
    ]);
    expect(widened.filteredCount).toBe(0);
  });

  it("keeps filtering INSIDE the time window only (filteredCount respects `since`)", () => {
    seedBoard();
    const read = readNotifications(projectDir, {
      since: "2026-01-01T00:00:10.000Z",
      filter: { type: "task.create" },
    });
    // Window = comment + create(b); 1 matched, 1 dropped. The older create(a)
    // is outside the window and must not be counted as filtered.
    expect(read.count).toBe(1);
    expect(read.filteredCount).toBe(1);
    expect(read.nextTs).toBe("2026-01-01T00:00:10.000Z");
  });
});

/**
 * The value validity the two routes share (ticket p3tkodry): a value that a
 * store could never hold is refused, everything else is opaque.
 */
describe("isValidNotificationFilterValue", () => {
  it("accepts the four real vocabularies", () => {
    for (const value of ["abc12345", "task.comment", "in-progress", "pi-4242", "agent one"]) {
      expect(isValidNotificationFilterValue(value)).toBe(true);
    }
  });

  it("refuses control characters smuggled through a query string", () => {
    expect(isValidNotificationFilterValue("a\u0000b")).toBe(false);
    expect(isValidNotificationFilterValue("a\nb")).toBe(false);
    expect(isValidNotificationFilterValue("a\tb")).toBe(false);
  });

  it("refuses an empty value and anything past the token length bound", () => {
    expect(isValidNotificationFilterValue("")).toBe(false);
    expect(isValidNotificationFilterValue("x".repeat(NOTIFICATION_FILTER_MAX_LENGTH))).toBe(true);
    expect(isValidNotificationFilterValue("x".repeat(NOTIFICATION_FILTER_MAX_LENGTH + 1))).toBe(false);
  });
});
