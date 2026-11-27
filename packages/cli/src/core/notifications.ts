/**
 * Local notification events (ticket ecba6126).
 *
 * Every local task mutation appends ONE event to
 * `<projectDir>/.vibeflow/notifications.jsonl` — an append-only JSONL log the
 * local board reads back through `GET /api/notifications?since=<iso>&limit=<n>`.
 * The log is a side channel, never the source of truth: the task files stay
 * authoritative and a notification that cannot be written must never fail the
 * write it describes (see {@link appendNotification}).
 *
 * Shape is deliberately flat and closed: one line per event, no nesting, no
 * cursor object. `since` is an inclusive ISO timestamp — at-least-once
 * delivery, so a boundary event may repeat but can never disappear.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { PROTO_DIR } from "./types.js";
import type {
  HookActivity,
  HookConfirmedPayloads,
} from "./hooks/activities.js";
// Type-only: `ConfirmedEffect` is the emitter's correlated activity+payload
// pair. Erased at build, so the store never pulls the hook runner in.
import type { ConfirmedEffect } from "./hooks/emit.js";
import { resolveAgentIdentity } from "./agent-identity.js";

/** Events kept on disk. Older lines are evicted (see {@link appendNotification}). */
export const NOTIFICATIONS_MAX_EVENTS = 500;

/** Default page size of {@link readNotifications} — the newest N events. */
export const NOTIFICATIONS_DEFAULT_LIMIT = 50;

/** Hard ceiling on {@link readNotifications}'s page size. */
export const NOTIFICATIONS_MAX_LIMIT = 200;

export interface NotificationEvent {
  /** `evt_` + 26 lowercase base32 chars (see {@link newNotificationId}). */
  id: string;
  /** ISO-8601 with ms — `new Date().toISOString()`. */
  ts: string;
  /**
   * CLOSED vocabulary — `HookActivity` minus `push`/`pull`, plus the board's
   * own `task.update`: `task.create` | `task.update` | `task.claim` |
   * `task.delete` | `task.comment` | `verify`.
   *
   * It is a PROJECTION of the same confirmed payload the after-hook narrates
   * ({@link notificationFromActivity}), never a second description of the
   * write. `push`/`pull` have no `taskId`, and an event is only useful if it
   * is actionable through `tasks --get <id>` — so they project to nothing.
   * The board's write routes share the same seam
   * ({@link appendConfirmedNotification}) and name the activity they
   * confirmed; only a file/screenshot write — which has no activity of its
   * own — keeps a panel-level `task.update` spelling (`files` |
   * `screenshot`), the vocabulary the board has always emitted.
   * A new category means a new activity, never an ad-hoc string here.
   */
  type: string;
  taskId: string;
  /** "agent" | "board" | `$VIBEFLOW_ACTOR` when set. */
  actor: string;
  /**
   * The agent that CAUSED the write, when the emitter explicitly knows one:
   * `$VIBEFLOW_ACTOR` locally, or `X-Vibeflow-Agent` on a hosted write.
   *
   * ABSENT for a human/board write and for an unset identity — deliberately,
   * because the follower's delivery filter keys on this field and an unknown
   * identity must never silence anything (see {@link isOwnNotification}).
   * `actor` stays the reader-facing label; it falls back to "agent" and so
   * cannot distinguish two agents sharing one credential.
   */
  agent?: string;
  /** Field names the mutation touched, when the emitter knows them. */
  changed?: string[];
  /** New values of the changed fields only (status, priority, assignee…). */
  to?: Record<string, unknown>;
}

/**
 * Identity the boundary supplies — the only event fields the projection
 * cannot derive from the confirmed payload. It never invents an actor: the
 * boundary knows whether it is the CLI, an MCP transport or the board.
 */
export interface NotificationExtras {
  /** "agent" | `$VIBEFLOW_ACTOR` | "board". */
  actor: string;
  /** Explicit agent identity; absent when the caller cannot name one. */
  agent?: string;
  /** ISO-8601 with ms; defaults to now (tests pin it). */
  ts?: string;
  /** `evt_…`; defaults to a fresh id (tests pin it). */
  id?: string;
}

/**
 * Identity for an event an agent-caused surface emits (CLI, MCP, hosted
 * write): `$VIBEFLOW_ACTOR` when the operator set it, else the historical
 * "agent" actor label — plus `agent`, the identity the follower matches to
 * suppress its own writes.
 *
 * `agent` comes from {@link resolveAgentIdentity}: the explicit variable, or
 * the pi session this process descends from (`pi-<pid>`, ticket b7dvqr7z).
 * The "agent" LABEL is shared by every unidentified agent, so it must never
 * become the identity — that would suppress a peer's event, trading noise for
 * blindness. No resolvable identity means no `agent` field at all, and the
 * follower then suppresses nothing (the honest residual).
 */
export function notificationIdentity(
  env: NodeJS.ProcessEnv = process.env,
): NotificationExtras {
  const explicit = env["VIBEFLOW_ACTOR"]?.trim();
  const identity = resolveAgentIdentity(env);
  return {
    actor: explicit !== undefined && explicit !== "" ? explicit : "agent",
    ...(identity.id !== undefined ? { agent: identity.id } : {}),
  };
}

/**
 * True when this event describes a write by THIS follower's own agent — the
 * one case `--follow` must not deliver (ticket kzxaq0fd).
 *
 * Only an explicitly set `selfAgent` can match: an unset identity returns
 * false for every event, which is the documented residual (no identity, no
 * suppression). The event's `agent` stays on the wire either way, so a
 * consumer of a complete `--json` read can apply its own rule.
 */
export function isOwnNotification(
  event: unknown,
  selfAgent: string | undefined,
): boolean {
  if (selfAgent === undefined || selfAgent === "") return false;
  const agent = (event as { agent?: unknown } | null)?.agent;
  return typeof agent === "string" && agent === selfAgent;
}

/** The parts of an event a projection fills in besides identity + type. */
interface NotificationParts {
  changed?: string[];
  to?: Record<string, unknown>;
}

/** One event: the caller's identity + the parts a projection derived. */
function notificationEvent(
  type: string,
  taskId: string,
  extras: NotificationExtras,
  parts: NotificationParts = {},
): NotificationEvent {
  return {
    id: extras.id ?? newNotificationId(),
    ts: extras.ts ?? new Date().toISOString(),
    type,
    taskId,
    actor: extras.actor,
    ...(extras.agent !== undefined ? { agent: extras.agent } : {}),
    ...(parts.changed !== undefined ? { changed: parts.changed } : {}),
    ...(parts.to !== undefined ? { to: parts.to } : {}),
  };
}

/**
 * One activity's projection: the CONFIRMED payload in, the event (or
 * `null` when the activity is not actionable) out.
 */
type ActivityProjection<A extends HookActivity> = (
  payload: HookConfirmedPayloads[A],
  extras: NotificationExtras,
) => NotificationEvent | null;

/**
 * activity → projection. Typed as a `Record` over the UNION, so the
 * compiler refuses a missing row: adding a ninth `HookActivity` breaks this
 * declaration instead of silently dropping a category of events.
 *
 * Every event names the task the payload confirms. `push`/`pull` are the
 * only activities that cannot: they carry no task id, and an event nobody
 * can resolve with `tasks --get <id>` is noise — they project to `null`.
 */
/**
 * Bookkeeping fields a write always touches. They say nothing about WHAT
 * happened, and an agent polling the feed must not be woken by them: a
 * comment-only edit produced \`task.update (updatedAt)\` beside the real
 * \`task.comment\`, which is noise that trains a consumer to ignore the feed.
 * The same list is enforced on the hosted surface (`server/notifications/ring`)
 * — the two backends must agree on it.
 *
 * On "1:1": the two backends share the envelope, the `since`/`limit` semantics
 * and this noise policy, but they are NOT identical, and the claim was
 * misleading (ticket t3og1r0u):
 * - `gap` on an EMPTY store differs by design. Memory has no persistence, so
 *   the hosted ring must call every empty store a gap; this log persists, so an
 *   empty log is a gap only when the epoch marker proves it once held events.
 * - the vocabulary differs at two edges: `task.claim` and `verify` are local
 *   only, `task.file` is hosted only (a local file write is a `task.update`
 *   whose `changed` names it).
 */
const METADATA_ONLY_KEYS: ReadonlySet<string> = new Set([
  "updatedAt",
  "sortKey",
  "rev",
]);

const PROJECTIONS: { [A in HookActivity]: ActivityProjection<A> } = {
  "task.create": (payload, extras) =>
    notificationEvent("task.create", payload.task.id, extras, {
      to: {
        status: payload.task.status,
        ...(payload.task.type ? { type: payload.task.type } : {}),
      },
    }),
  "task.update": (payload, extras) => {
    const changed = payload.changed.filter((key) => !METADATA_ONLY_KEYS.has(key));
    // Nothing but bookkeeping moved: the answer is "no event". A comment-only
    // edit still reports itself through `task.comment`.
    if (changed.length === 0) return null;
    return notificationEvent("task.update", payload.taskId, extras, { changed });
  },
  "task.claim": (payload, extras) =>
    notificationEvent("task.claim", payload.taskId, extras, {
      changed: ["status"],
      to: { from: payload.from, to: payload.to },
    }),
  "task.delete": (payload, extras) =>
    notificationEvent("task.delete", payload.taskId, extras, {
      to: { childCount: payload.childCount },
    }),
  "task.comment": (payload, extras) =>
    notificationEvent("task.comment", payload.taskId, extras, {
      to: { commentId: payload.commentId },
    }),
  verify: (payload, extras) =>
    notificationEvent("verify", payload.taskId, extras, {
      to: { verdict: payload.verdict },
    }),
  push: () => null,
  pull: () => null,
};

/**
 * Project ONE confirmed activity into the event the board reads
 * (ticket ecba6126). This is the whole notification vocabulary: the same
 * `HookActivity` + `HookConfirmedPayloads` pair the after-hook narrates, so
 * a new activity is a deliberate decision here and nowhere else.
 *
 * Returns `null` for an activity that must not produce an event (`push`,
 * `pull`). Never throws by construction — the caller still guards the
 * write itself ({@link appendNotification}).
 */
export function notificationFromActivity<A extends HookActivity>(
  activity: A,
  payload: HookConfirmedPayloads[A],
  extras: NotificationExtras,
): NotificationEvent | null {
  return PROJECTIONS[activity](payload, extras);
}

/**
 * Project one confirmed effect. Generic over the activity so the
 * `activity`/`payload` pair narrows together — the reason the loop below can
 * hand a whole `ConfirmedEffect` union to the projection table without a cast.
 */
function projectConfirmed<A extends HookActivity>(
  effect: { activity: A; payload: HookConfirmedPayloads[A] },
  extras: NotificationExtras,
): NotificationEvent | null {
  return PROJECTIONS[effect.activity](effect.payload, extras);
}

/**
 * Project EVERY confirmed effect of one invocation into its notification
 * (ticket ecba6126). One event per EFFECT, not per command: `--edit
 * --set-status X --comment "…"` confirms `task.update` AND `task.comment`,
 * and dropping either would hide half of what happened. Effects that
 * project to `null` (`push`, `pull`) are skipped.
 */
export function notificationsFromConfirmed(
  confirmed: readonly ConfirmedEffect[],
  extras: NotificationExtras,
): NotificationEvent[] {
  const events: NotificationEvent[] = [];
  for (const effect of confirmed) {
    const event = projectConfirmed(effect, extras);
    if (event !== null) events.push(event);
  }
  return events;
}

/**
 * THE append seam for one confirmed activity (ticket mzxp8u98): project the
 * confirmed payload through the ONE table and append the result.
 *
 * The CLI invocation boundary and the local board's write routes both call
 * this — a board click never reaches `emitAfterHook`, so it used to write a
 * WebSocket frame and nothing else. Sharing the seam (rather than a second
 * board-local mapping) is what keeps both surfaces describing the same
 * effect the same way. The kill switch lives here so no caller can forget it.
 *
 * Never throws: {@link appendNotification} swallows every store failure, and
 * the projection is total over the activity union.
 */
export function appendConfirmedNotification<A extends HookActivity>(
  projectDir: string,
  effect: { activity: A; payload: HookConfirmedPayloads[A] },
  extras: NotificationExtras,
): NotificationEvent | null {
  if (!notificationsEnabled()) return null;
  const event = projectConfirmed(effect, extras);
  if (event !== null) appendNotification(projectDir, event);
  return event;
}

/**
 * The subscription dimensions a read may narrow on (ticket p3tkodry). ONE list
 * for both backends: the local board and the hosted ring expose the same four
 * params with the same semantics (the parity goal of ticket 0045949e).
 *
 * The names are the WIRE names — the query parameter IS the dimension, so a
 * client that asks for `?status=` means the same thing everywhere.
 */
export const NOTIFICATION_FILTER_DIMENSIONS = [
  "taskId",
  "type",
  "status",
  "agent",
] as const;

export type NotificationFilterDimension =
  (typeof NOTIFICATION_FILTER_DIMENSIONS)[number];

/**
 * Server-side subscription of ONE read (ticket p3tkodry). Every present
 * dimension must match (AND); an absent or empty one imposes nothing.
 *
 * A dimension value is an opaque token, validated only by
 * {@link isValidNotificationFilterValue} — the four vocabularies differ in
 * shape (`abc123`, `task.comment`, `in-progress`, `pi-4242`) and a stricter
 * grammar would refuse legitimate data. A value that is WELL FORMED but names
 * something this backend never emits (`?type=verify` on the hosted ring)
 * narrows to zero events, explicitly: that is the documented vocabulary edge,
 * not a reason to widen behind the caller's back.
 */
export type NotificationFilter = Partial<
  Record<NotificationFilterDimension, string>
>;

/** Longest accepted dimension value — ids and labels, never documents. */
export const NOTIFICATION_FILTER_MAX_LENGTH = 128;

/**
 * Validity of ONE dimension value: non-empty, at most
 * {@link NOTIFICATION_FILTER_MAX_LENGTH} characters, no control characters.
 *
 * Whitespace INSIDE a value is allowed on purpose: `agent` is a caller-chosen
 * identity label (`$VIBEFLOW_ACTOR`), not an id grammar. A whitespace-only
 * value means "no constraint" (the routes treat it as absent, the way they
 * already treat an empty `since`), so a fat-fingered blank widens instead of
 * hiding the feed. What cannot be a stored value at all — a NUL byte or a
 * newline smuggled in through the query string — is refused.
 */
export function isValidNotificationFilterValue(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= NOTIFICATION_FILTER_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * The status an event ANNOUNCES: `to.status` (create / hosted patch) or the
 * destination of a claim, which the local vocabulary names `to.to`
 * (`{from, to}`).
 *
 * Deliberate asymmetry, documented rather than papered over: a LOCAL
 * `task.update` payload carries only the changed KEY NAMES (no new values), so
 * locally only `task.create`/`task.claim` are status-narrowable, while the
 * hosted ring's `task.patch` copy does carry the patched values. Same
 * predicate, same spelling, different data — a `?status=` reader on a local
 * board sees creations and claims, not every edit that wrote a status
 * (ticket p3tkodry).
 */
export function notificationStatusOf(
  event: NotificationEvent,
): string | undefined {
  const to = event.to;
  if (to === undefined) return undefined;
  if (typeof to.status === "string") return to.status;
  return typeof to.to === "string" ? to.to : undefined;
}

/**
 * dimension → "does this event satisfy it". Keyed by the union, so a new
 * dimension breaks this table instead of silently never matching.
 */
const FILTER_PREDICATES: {
  [D in NotificationFilterDimension]: (
    event: NotificationEvent,
    value: string,
  ) => boolean;
} = {
  taskId: (event, value) => event.taskId === value,
  type: (event, value) => event.type === value,
  status: (event, value) => notificationStatusOf(event) === value,
  agent: (event, value) => event.agent === value,
};

/**
 * Does this event pass the subscription? Absent filter, and an absent or empty
 * dimension, ⇒ true. An UNKNOWN dimension ⇒ true as well: widening is the only
 * safe answer to a dimension this backend does not implement (a newer client
 * against an older board must see MORE than it asked for, never less).
 */
export function matchesNotificationFilter(
  event: NotificationEvent,
  filter: NotificationFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  for (const [dimension, value] of Object.entries(filter)) {
    if (value === undefined || value.trim() === "") continue;
    const predicate =
      FILTER_PREDICATES[dimension as NotificationFilterDimension];
    if (predicate === undefined) continue;
    if (!predicate(event, value)) return false;
  }
  return true;
}

export interface NotificationReadResult {
  /** Oldest → newest (file order is append order; never re-sorted). */
  notifications: NotificationEvent[];
  /**
   * The READ CURSOR: the newest point up to which every stored event in the
   * `since` window has been accounted for — matched or filtered.
   *
   * It is NOT "the last event in the page". While the subscription drops
   * events, `nextTs` is pinned at the OLDEST dropped one, so the cursor can
   * never advance past an event the filter hid: change the filter later and
   * that event is still ahead of the cursor (ticket p3tkodry). The follower
   * re-reads from there — `since` is inclusive and it dedupes by id — and the
   * honest cost is that a cursor pinned long enough has its events evicted by
   * the 500-event cap, which the ordinary `gap` warning then reports.
   *
   * `null` only when there is nothing stored, no cursor and nothing dropped.
   */
  nextTs: string | null;
  /** Oldest event currently stored; null when the log is empty. */
  earliestTs: string | null;
  /**
   * "Events you asked for are gone": either `since` is older than the oldest
   * stored event (eviction), or the log is empty while the epoch marker shows
   * it once held events (deleted/cleared under a follower with a cursor).
   */
  gap: boolean;
  /** True iff more events matched than `limit` allowed (the NEWEST win). */
  truncated: boolean;
  /** `notifications.length`. */
  count: number;
  /**
   * Events inside the `since` window the SUBSCRIPTION dropped
   * (`window - matched`), so a filtered follower always learns that something
   * was filtered — counts, never silence. Events dropped by `limit` belong to
   * `truncated`: those did match.
   */
  filteredCount: number;
}

/** Base32 (RFC 4648 lowercase, digits 2-7) — 5 bits per char. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Mint an event id: `evt_` + 26 base32 chars (130 bits of randomness).
 * `byte % 32` is uniform because 256 is an exact multiple of 32.
 */
export function newNotificationId(): string {
  const bytes = randomBytes(26);
  let id = "evt_";
  for (let i = 0; i < bytes.length; i++) {
    id += BASE32_ALPHABET[bytes[i]! % 32];
  }
  return id;
}

/** `<projectDir>/.vibeflow/notifications.jsonl`. */
export function notificationsPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, "notifications.jsonl");
}

/**
 * `<projectDir>/.vibeflow/notifications.epoch` — "this log has held events
 * before", so an EMPTY log can be told apart from a DESTROYED one (ticket
 * t3og1r0u).
 *
 * The distinction is the whole reason the two backends disagreed: the hosted
 * ring lives in memory, so an empty ring can only mean "a restart took your
 * events" and it must report a gap. The local log persists, so an empty log
 * usually means "nothing was ever written" and a gap would be a false alarm —
 * EXCEPT when the file was deleted or cleared while a follower held a cursor,
 * which is the one case where the follower was told nothing was lost while
 * everything was. A marker written on the first append (and never removed by
 * a log reset) makes that case detectable without pretending the two storages
 * are the same.
 *
 * Deliberately NOT written on read: a read is a read. A project that had
 * events before this change and had its log destroyed before any new event
 * was appended still looks fresh — the documented residual.
 */
export function notificationsEpochPath(projectDir: string): string {
  return join(projectDir, PROTO_DIR, "notifications.epoch");
}

/**
 * Kill switch for the whole feature: `VIBEFLOW_EVENTS=0` disables every
 * emitter (tests set it in the unit setup so no notification file is ever
 * created there). Anything else — including unset — leaves events ON.
 */
export function notificationsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.VIBEFLOW_EVENTS !== "0";
}

/** Parse one JSONL line; a blank or malformed line is skipped, never fatal. */
function parseEventLine(line: string): NotificationEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null) return null;
    const e = parsed as Partial<NotificationEvent>;
    if (
      typeof e.id !== "string" ||
      typeof e.ts !== "string" ||
      typeof e.type !== "string" ||
      typeof e.taskId !== "string" ||
      typeof e.actor !== "string"
    ) {
      return null;
    }
    return {
      id: e.id,
      ts: e.ts,
      type: e.type,
      taskId: e.taskId,
      actor: e.actor,
      ...(Array.isArray(e.changed) ? { changed: e.changed } : {}),
      ...(typeof e.agent === "string" ? { agent: e.agent } : {}),
      ...(e.to !== undefined && typeof e.to === "object" && e.to !== null
        ? { to: e.to }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Read every stored event, tolerantly, in file (append) order. */
function readStoredEvents(projectDir: string): NotificationEvent[] {
  let raw: string;
  try {
    raw = readFileSync(notificationsPath(projectDir), "utf-8");
  } catch {
    // A missing (or unreadable) log is an empty log — never a read failure.
    return [];
  }
  const events: NotificationEvent[] = [];
  for (const line of raw.split("\n")) {
    const event = parseEventLine(line);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Keep the log bounded: when it holds more than {@link NOTIFICATIONS_MAX_EVENTS}
 * events, rewrite it with the last N lines (tmp + rename, so a reader never
 * sees a half-written file). Throws — {@link appendNotification} swallows it.
 */
function trimStoredEvents(filePath: string): void {
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length <= NOTIFICATIONS_MAX_EVENTS) return;
  const kept = lines.slice(-NOTIFICATIONS_MAX_EVENTS);
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, kept.join("\n") + "\n", "utf-8");
  renameSync(tmp, filePath);
}

/**
 * Append one event — BEST EFFORT, never throws. A notification is a side
 * channel: losing one must never turn a task write that succeeded into a
 * failure, so every failure mode (unwritable project, bad path, full disk) is
 * swallowed here and nowhere else.
 */
export function appendNotification(
  projectDir: string,
  event: NotificationEvent,
): void {
  try {
    mkdirSync(join(projectDir, PROTO_DIR), { recursive: true });
    const filePath = notificationsPath(projectDir);
    // First event ever: remember that this log has held events, so a later
    // reset is reportable as a gap instead of as silence (ticket t3og1r0u).
    const epochPath = notificationsEpochPath(projectDir);
    if (!existsSync(epochPath)) {
      writeFileSync(epochPath, new Date().toISOString() + "\n", "utf-8");
    }
    appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
    trimStoredEvents(filePath);
  } catch {
    /* a notification must never fail a task write */
  }
}

/**
 * Normalise a caller-supplied `since` to the canonical `toISOString()` form
 * before comparing. Every stored `ts` is written by `toISOString()`, so a
 * plain string comparison is only sound when the caller's value is in that
 * exact shape — `2026-11-22T16:30:33+02:00` or a date-only value would
 * otherwise compare lexically and silently skip (or replay) events. An
 * unparseable value is returned untouched; the HTTP route rejects it with
 * `INVALID_SINCE` before it ever reaches here.
 */
function normalizeSince(since: string): string {
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? since : new Date(parsed).toISOString();
}

/** Page size: absent/invalid → the default; above the ceiling → the ceiling. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return NOTIFICATIONS_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), NOTIFICATIONS_MAX_LIMIT);
}

/**
 * Read the log for a polling client.
 *
 * - `since` is INCLUSIVE (`ts >= since`): at-least-once delivery, so the
 *   boundary event may repeat but can never be missed.
 * - `filter` (ticket p3tkodry) narrows the page SERVER-SIDE: only events that
 *   pass {@link matchesNotificationFilter} are returned, `filteredCount` says
 *   how many the subscription dropped, and `nextTs` stays behind the rest (see
 *   its own doc).
 * - `limit` keeps the NEWEST `limit` matches; `truncated` says more matched.
 * - `gap` warns that `since` predates what is still stored, i.e. events the
 *   caller never saw were evicted and it must re-read instead of paging.
 */
export function readNotifications(
  projectDir: string,
  opts: { since?: string; limit?: number; filter?: NotificationFilter } = {},
): NotificationReadResult {
  const stored = readStoredEvents(projectDir);
  const earliestTs = stored.length > 0 ? stored[0]!.ts : null;
  const since = opts.since === undefined ? undefined : normalizeSince(opts.since);
  const window =
    since === undefined ? stored : stored.filter((event) => event.ts >= since);
  // Subscription BEFORE paging: events the caller asked not to be handed never
  // occupy a page slot and can never crowd out a match.
  const matched: NotificationEvent[] = [];
  const dropped: NotificationEvent[] = [];
  for (const event of window) {
    (matchesNotificationFilter(event, opts.filter) ? matched : dropped).push(
      event,
    );
  }
  const limit = resolveLimit(opts.limit);
  const truncated = matched.length > limit;
  const notifications = truncated ? matched.slice(matched.length - limit) : matched;
  // The cursor stops at the oldest DROPPED event: advancing past it would put
  // an event behind the caller that it never got the chance to change its mind
  // about (ticket p3tkodry). An unfiltered read is unchanged — nothing dropped,
  // so the last returned event is the cursor, exactly as before.
  const lastReturnedTs =
    notifications.length > 0
      ? notifications[notifications.length - 1]!.ts
      : undefined;
  const pinnedTs = dropped[0]?.ts;
  let nextTs: string | null;
  if (lastReturnedTs !== undefined && pinnedTs !== undefined) {
    nextTs = lastReturnedTs < pinnedTs ? lastReturnedTs : pinnedTs;
  } else {
    nextTs = lastReturnedTs ?? pinnedTs ?? since ?? null;
  }
  // `gap` = "events you never saw are gone". Two ways that happens:
  //   1. the log still holds events but `since` predates the oldest (eviction);
  //   2. the log holds NOTHING while the epoch marker proves it once did —
  //      i.e. it was deleted or cleared under a follower that has a cursor.
  // A genuinely fresh project (no events, no marker) is neither: it reports no
  // gap, because nothing was lost. The hosted ring cannot make that
  // distinction — memory has no persistence — so it treats every empty store
  // as a gap. That difference is intentional and documented in both headers.
  const logDestroyed =
    earliestTs === null &&
    since !== undefined &&
    existsSync(notificationsEpochPath(projectDir));
  const gap =
    since !== undefined &&
    (logDestroyed || (earliestTs !== null && since < earliestTs));
  return {
    notifications,
    nextTs,
    earliestTs,
    gap,
    truncated,
    count: notifications.length,
    filteredCount: dropped.length,
  };
}
