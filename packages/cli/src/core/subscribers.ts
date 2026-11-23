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
 */

/** A follower's heartbeat window. Must be a multiple of the CLI's interval. */
export const SUBSCRIBER_TTL_MS = 90_000;

/** How often `vibeflow notifications --follow` re-registers. */
export const SUBSCRIBER_HEARTBEAT_MS = 30_000;

export interface SubscriberIdentity {
  /** Random per follower process (`sub_…`); the unsubscribe key. */
  subscriberId: string;
  /** `$VIBEFLOW_ACTOR`, else the literal "agent" (the CLI's actor rule). */
  agent: string;
  /** "local" on the local board: there is no account to name. */
  user: string;
}

/** What the badge consumes: one row per user/agent with live followers. */
export interface SubscriberSnapshot {
  total: number;
  byUser: Array<{ user: string; agents: number }>;
  byAgent: Array<{ agent: string; count: number }>;
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
    registeredAt: previous?.registeredAt ?? now,
    lastSeenAt: now,
  });
  registries.set(boardId, registry);
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
 * The live snapshot, aggregated for the badge: total followers, followers
 * per user label, and followers per agent label. Sorted highest-count first
 * then name, so the same registry always renders the same order.
 */
export function listSubscribers(
  boardId: string,
  now: number = Date.now(),
): SubscriberSnapshot {
  const registry = purge(boardId, now);
  const users = new Map<string, number>();
  const agents = new Map<string, number>();
  let total = 0;
  for (const entry of registry?.values() ?? []) {
    total += 1;
    users.set(entry.user, (users.get(entry.user) ?? 0) + 1);
    agents.set(entry.agent, (agents.get(entry.agent) ?? 0) + 1);
  }
  return {
    total,
    byUser: [...users.entries()]
      .map(([user, count]) => ({ user, agents: count }))
      .sort((a, b) => b.agents - a.agents || a.user.localeCompare(b.user)),
    byAgent: [...agents.entries()]
      .map(([agent, count]) => ({ agent, count }))
      .sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent)),
  };
}
