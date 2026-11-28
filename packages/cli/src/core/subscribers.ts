/**
 * Local subscriber registry: who is FOLLOWING this board's notification
 * feed right now.
 *
 * ONE contract, two backends — this module is the local board's image of the
 * hosted `packages/web/src/server/notifications/subscribers.ts`. The literal
 * is duplicated on purpose, exactly like the notification ring: the shared
 * contract must not drag the CLI into the web bundle.
 *
 * A subscriber is an explicit REGISTRATION (a POST from
 * `vibeflow notifications --follow`), never inferred from a socket: sockets
 * carry browser tabs, and a browser tab is not an agent watching the feed.
 *
 * Deliberate properties:
 * - In-memory only. Restarting `serve` empties the registry, so the badge
 *   reports 0 rather than a ghost — the same visible trade the ring
 *   documents. Nothing is persisted and no migration exists.
 * - `lastSeenAt` is refreshed by a heartbeat (the same POST). An entry whose
 *   heartbeat is older than {@link SUBSCRIBER_TTL_MS} is gone on the next
 *   read; nothing sweeps in the background.
 * - Re-registering an id is idempotent: the original `registeredAt` is kept
 *   and only liveness/identity refresh. Two followers sharing one id (a
 *   copied process) are one subscriber, which is what the badge counts.
 * - `activity` is the last event the follower DELIVERED (ticket ifhh7q2). It
 *   is overwritten by every register/heartbeat, never accumulated: the badge
 *   reports "what it last read", and a stale delivery must not outlive the
 *   next heartbeat that carries the current one.
 * - `current` is the follower's "working on" CLAIM (ticket qxvptxkta): the
 *   task its agent was last seen taking up, with the delivery time as the TTL
 *   clock — see {@link TASK_CLAIM_TTL_MS}.
 * - `status` is the follower's free-text self report (ticket w7knq2anvb14axzpea5k7qwv):
 *   the one-shot `vibeflow agents status` command writes it, a heartbeat that
 *   omits it PRESERVES it (unlike activity/current), `null` clears it, and it
 *   dies with the row — a status can never outlive the process it describes.
 *
 * ## Why the claim lives HERE and not on the task
 *
 * A claim must never outlive the process that made it. This registry is the
 * one place where that is free: it is in-memory, it is never persisted, and a
 * process that stops heartbeating is PURGED on the next read. Writing the
 * claim to the task record instead would be wrong twice over: the record is
 * `z.strict()`, so an unknown root key QUARANTINES the task, and a sidecar
 * under `.vibeflow/tasks/` is resolved by `findTaskFilePath` AS the record —
 * the trap ticket dh4jdeta documents for the lease sidecar. A persisted claim
 * would also survive the restart that killed its writer, which is precisely
 * the frozen "working on X" line this design exists to remove.
 */

/** A follower's heartbeat window. Must be a multiple of the CLI's interval. */
export const SUBSCRIBER_TTL_MS = 90_000;

/** How often `vibeflow notifications --follow` re-registers. */
export const SUBSCRIBER_HEARTBEAT_MS = 30_000;

/**
 * How long a "working on" claim stays credible after the delivery it came
 * from, in milliseconds.
 *
 * 3 × the heartbeat, the same number as {@link SUBSCRIBER_TTL_MS}, and the
 * two clocks answer two different questions:
 * - `SUBSCRIBER_TTL_MS` — is the PROCESS still alive? A dead follower's whole
 *   entry (claim included) is purged, so its claim cannot survive it.
 * - `TASK_CLAIM_TTL_MS` — was work on that task still being DELIVERED? A live
 *   follower that delivered nothing for that task stops claiming it, so a live
 *   but idle agent fades to `idle, watching` instead of holding a frozen line.
 *   The heartbeat CARRIES the claim (it rides the identity, so no second timer
 *   exists); it deliberately does not refresh this clock, because a heartbeat
 *   proves the process lives, not that it is still working that task.
 */
export const TASK_CLAIM_TTL_MS = 90_000;

/**
 * One follower's "working on" claim: the task its agent was last seen taking
 * up, and when that was DELIVERED.
 */
export interface TaskClaim {
  /** The task the delivered event named. */
  taskId: string;
  /** The agent that CAUSED the work (the event's `agent`), not the follower. */
  agent: string;
  /** When this follower delivered the work signal (epoch ms) — the TTL clock. */
  at: number;
}

/** The last feed event a follower delivered, as its identity reports it. */
export interface SubscriberActivity {
  /** The task the delivered event named, when it named one. */
  taskId?: string;
  /** The delivered event's type (`task.claim`, `task.comment`, `verify`, …). */
  type?: string;
  /** When the follower delivered it (epoch ms). */
  at: number;
}

/**
 * Longest status text kept from `vibeflow agents status`: 140 chars after
 * trim (ticket w7knq2anvb14axzpea5k7qwv). It fits the badge's one ellipsised
 * line (mock #2) without widening the popover; longer text is TRUNCATED, never
 * rejected, so a status ping is never lost to a length mistake.
 */
export const MAX_SUBSCRIBER_STATUS_LENGTH = 140;

/**
 * A follower's free-text self report, set by `vibeflow agents status`. Stored
 * on the same in-memory row as the identity — never on the task record — so it
 * dies with the follower at the heartbeat TTL (ticket w7knq2anvb14axzpea5k7qwv).
 */
export interface SubscriberStatus {
  /** The trimmed report, at most {@link MAX_SUBSCRIBER_STATUS_LENGTH} chars. */
  text: string;
  /** When the status was SET (epoch ms). A heartbeat never refreshes it. */
  at: number;
}

export interface SubscriberIdentity {
  /** Random per follower process (`sub_…`); the unsubscribe key. */
  subscriberId: string;
  /** `$VIBEFLOW_ACTOR`, else the literal "agent" (the CLI's actor rule). */
  agent: string;
  /** "local" on the local board: there is no account to name. */
  user: string;
  /** Last delivered event; absent until the follower has delivered one. */
  activity?: SubscriberActivity;
  /** The agent's own status report; absent when it never set one. */
  status?: SubscriberStatus;
  /** The task this follower's agent is working on; absent when it claimed none. */
  current?: TaskClaim;
}

/** One live follower, as the badge lists it. */
interface SubscriberSnapshotEntry {
  subscriberId: string;
  user: string;
  agent: string;
  /** First registration of this id in this process (ms). */
  registeredAt: number;
  /** Last register/heartbeat (ms); the TTL clock. */
  lastSeenAt: number;
  activity?: SubscriberActivity;
  current?: TaskClaim;
  status?: SubscriberStatus;
}

/** What the badge consumes: live followers plus the legacy aggregates. */
export interface SubscriberSnapshot {
  total: number;
  byUser: Array<{ user: string; agents: number }>;
  byAgent: Array<{ agent: string; count: number }>;
  /** One row per live follower, most recent activity first. */
  subscribers: SubscriberSnapshotEntry[];
}

interface SubscriberEntry extends SubscriberIdentity {
  /** First registration of this id in this process (ms). */
  registeredAt: number;
  /** Last register/heartbeat (ms); the TTL clock. */
  lastSeenAt: number;
}

/** Board id → subscriber id → entry. One registry per served project. */
const registries = new Map<string, Map<string, SubscriberEntry>>();

/** Test hook: a fresh process (or a restart) starts with no subscribers. */
export function __resetSubscribersForTests(): void {
  registries.clear();
}

function isAlive(entry: SubscriberEntry, now: number): boolean {
  // Strictly less-than: at exactly the TTL the entry is expired, so the
  // boundary is deterministic and a heartbeat must land before it.
  return now - entry.lastSeenAt < SUBSCRIBER_TTL_MS;
}

/**
 * Drop expired entries and return the live map, or null when the board has
 * no live subscriber left. The only purge path — every read/write goes
 * through it, so a ghost cannot survive an operation.
 */
function purge(boardId: string, now: number): Map<string, SubscriberEntry> | null {
  const registry = registries.get(boardId);
  if (!registry) return null;
  for (const [id, entry] of registry) {
    if (!isAlive(entry, now)) registry.delete(id);
  }
  if (registry.size === 0) {
    registries.delete(boardId);
    return null;
  }
  return registry;
}

/**
 * The live "working on" claims, one per task: the newest claim wins when two
 * followers claim the same task (the later delivery is the better evidence,
 * and the read never invents a merged owner).
 *
 * Expired claims are DROPPED, never returned with an age the caller could
 * render as a stale "working on" line — the same rule `purge` applies to the
 * followers themselves. `taskId` narrows to one task (the DetailPanel's read),
 * applied after the TTL check so a narrow read cannot resurrect a claim the
 * wide read already reports as gone.
 */
export function listTaskClaims(
  boardId: string,
  now: number = Date.now(),
  taskId?: string,
): TaskClaim[] {
  const registry = purge(boardId, now);
  const newest = new Map<string, TaskClaim>();
  for (const entry of registry?.values() ?? []) {
    const claim = entry.current;
    if (claim === undefined) continue;
    if (now - claim.at >= TASK_CLAIM_TTL_MS) continue;
    if (taskId !== undefined && claim.taskId !== taskId) continue;
    const previous = newest.get(claim.taskId);
    if (previous === undefined || claim.at > previous.at) {
      newest.set(claim.taskId, claim);
    }
  }
  return [...newest.values()].sort(
    (a, b) => b.at - a.at || a.taskId.localeCompare(b.taskId),
  );
}

/** Register a follower — also the heartbeat (same id, refreshed clock). */
export function registerSubscriber(
  boardId: string,
  identity: SubscriberIdentity,
  now: number = Date.now(),
): void {
  const registry = purge(boardId, now) ?? new Map<string, SubscriberEntry>();
  const previous = registry.get(identity.subscriberId);
  registry.set(identity.subscriberId, {
    ...identity,
    // `status` is preserved when a heartbeat omits it — unlike activity and
    // current, which clear on absence. Its writer is the one-shot
    // `agents status` command, so an absent field must not wipe what it set;
    // only updateSubscriberStatus(..., null) clears (ticket w7knq2anvb14axzpea5k7qwv).
    ...(identity.status === undefined && previous?.status !== undefined
      ? { status: previous.status }
      : {}),
    registeredAt: previous?.registeredAt ?? now,
    lastSeenAt: now,
  });
  registries.set(boardId, registry);
}

/**
 * Apply a status-only update from `vibeflow agents status`
 * (ticket w7knq2anvb14axzpea5k7qwv). `null` clears, a value replaces,
 * `undefined` drops a malformed update (the route still requires a live row
 * but writes nothing). Deliberately does NOT touch `lastSeenAt`: a one-shot
 * command must not resurrect a dead follower's row — liveness is the
 * FOLLOWER's heartbeat alone. Returns false when no live row exists, so the
 * route can refuse NO_LIVE_AGENT and write nothing.
 */
export function updateSubscriberStatus(
  boardId: string,
  subscriberId: string,
  status: SubscriberStatus | null | undefined,
  now: number = Date.now(),
): boolean {
  const registry = purge(boardId, now);
  const entry = registry?.get(subscriberId);
  if (entry === undefined) return false;
  if (status === null) delete entry.status;
  else if (status !== undefined) entry.status = status;
  return true;
}

/** Remove a follower. Idempotent: an unknown/expired id is `false`. */
export function removeSubscriber(
  boardId: string,
  subscriberId: string,
  now: number = Date.now(),
): boolean {
  const registry = purge(boardId, now);
  if (!registry) return false;
  const removed = registry.delete(subscriberId);
  if (registry.size === 0) registries.delete(boardId);
  return removed;
}

/**
 * The live snapshot: one row per follower (for the badge's activity list)
 * plus the legacy per-user/per-agent aggregates, which stay unchanged so an
 * older consumer keeps working. Rows sort most recent activity first, then
 * heartbeat, then id — deterministic for the same registry.
 */
export function listSubscribers(
  boardId: string,
  now: number = Date.now(),
): SubscriberSnapshot {
  const registry = purge(boardId, now);
  const users = new Map<string, number>();
  const agents = new Map<string, number>();
  const subscribers: SubscriberSnapshotEntry[] = [];
  let total = 0;
  for (const entry of registry?.values() ?? []) {
    total += 1;
    users.set(entry.user, (users.get(entry.user) ?? 0) + 1);
    agents.set(entry.agent, (agents.get(entry.agent) ?? 0) + 1);
    subscribers.push({
      subscriberId: entry.subscriberId,
      user: entry.user,
      agent: entry.agent,
      registeredAt: entry.registeredAt,
      lastSeenAt: entry.lastSeenAt,
      ...(entry.activity !== undefined ? { activity: entry.activity } : {}),
      ...(entry.current !== undefined ? { current: entry.current } : {}),
      ...(entry.status !== undefined ? { status: entry.status } : {}),
    });
  }
  subscribers.sort(
    (a, b) =>
      (b.activity?.at ?? 0) - (a.activity?.at ?? 0) ||
      b.lastSeenAt - a.lastSeenAt ||
      a.subscriberId.localeCompare(b.subscriberId),
  );
  return {
    total,
    byUser: [...users.entries()]
      .map(([user, count]) => ({ user, agents: count }))
      .sort((a, b) => b.agents - a.agents || a.user.localeCompare(b.user)),
    byAgent: [...agents.entries()]
      .map(([agent, count]) => ({ agent, count }))
      .sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent)),
    subscribers,
  };
}
