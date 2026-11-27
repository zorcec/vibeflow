/**
 * Subscriber side-calls for `vibeflow notifications --follow` (the "Watching"
 * badge, ticket cgor65lmpv31cib1ef9zce5m).
 *
 * The feed read is `notifications-fetch.ts`; this module is the WRITE half of
 * the same contract: register on start, heartbeat while following, and
 * unregister on the way out. Every call is BEST EFFORT and returns a result
 * instead of throwing — a feed must keep working when the badge cannot, and a
 * registration failure is a diagnostic on stderr, never a fetch failure.
 *
 * Targets are the SAME two backends the feed resolves to:
 * - `online` → `{apiUrl}/api/v0/notifications/subscribers`, the project's own
 *   token plus the board-scope header (ADR-0005 — never an ambient credential).
 * - `local` → `http://localhost:<config.json port>/api/notifications/subscribers`.
 *   The local board has no account, so the server labels every follower
 *   "local"; the CLI sends no user field.
 *
 * Identity: one random `sub_<uuid>` per process (the unsubscribe key and the
 * idempotent re-register key) and the SAME actor spelling the notification
 * events already use — `$VIBEFLOW_ACTOR`, else "agent".
 *
 * Activity (ticket ifhh7q2): the identity also carries the LAST event this
 * follower actually delivered — `{ taskId?, type?, at }` — so the badge can
 * say what the follower is doing, not just that it exists. It is overwritten
 * as the feed moves and is never inferred from the task assignee: the
 * follower is a reader, and guessing who writes would be a lie.
 *
 * Current (ticket qxvptxkta): the identity additionally carries the "working
 * on" CLAIM — the task THIS agent was last seen taking up. It is set from a
 * delivered `task.claim` / `to.status: in-progress` event written by the
 * follower's own agent, cleared when that task leaves in-progress, and it
 * rides every register/heartbeat because it lives on this identity object.
 * That is the whole renewal mechanism: no second timer. Its TTL lives in the
 * registry (`TASK_CLAIM_TTL_MS`), which also reaps the entry when the process
 * stops heartbeating — so the claim can never outlive the process.
 */

import { createHash, randomUUID } from "node:crypto";
import { scopeHeaderFor } from "../auth/board-scope.js";
import { resolveAgentIdentity } from "./agent-identity.js";
import { fetchWithTimeout } from "../saas/request.js";
import { getApiUrl } from "./api-url.js";
import { readConfig } from "./config.js";
import {
  resolveOnlineAccess,
  type FetchTransport,
  type NotificationTarget,
} from "./notifications-fetch.js";
import type { TaskClaim } from "./subscribers.js";

/** The follower's re-registration cadence — the registry owns the number. */
export { SUBSCRIBER_HEARTBEAT_MS } from "./subscribers.js";

/** The hosted subscriber route — mirror of the feed's v0 path. */
export const NOTIFICATION_SUBSCRIBERS_V0_PATH =
  "/api/v0/notifications/subscribers";

/** The local board's route; the hosted board serves the same body on v0. */
export const NOTIFICATION_SUBSCRIBERS_LOCAL_PATH =
  "/api/notifications/subscribers";

/** A heartbeat side-call must never stall the feed loop it belongs to. */
const SUBSCRIBER_REQUEST_TIMEOUT_MS = 5_000;

/** On exit the user is waiting for Ctrl-C to finish; bound the goodbye. */
const SUBSCRIBER_UNREGISTER_TIMEOUT_MS = 2_000;

/** The last feed event this follower delivered, as the registry stores it. */
export interface SubscriberActivity {
  /** The task the delivered event named, when it named one. */
  taskId?: string;
  /** The delivered event's type (`task.claim`, `task.comment`, `verify`, …). */
  type?: string;
  /** When THIS follower delivered the event (epoch ms) — not the event's ts. */
  at: number;
}

export interface NotificationSubscriberIdentity {
  /**
   * The registry key. `sub_` + a hash of the agent identity when one exists
   * (so a RESTARTED follower replaces its own row), else `sub_` + a random
   * UUID (two unidentified followers are genuinely indistinguishable, and
   * inventing a shared key would merge strangers into one row).
   */
  subscriberId: string;
  /** `$VIBEFLOW_ACTOR`, else "agent" — the event actor rule. */
  agent: string;
  /** Last delivered event; absent until the follower has delivered one. */
  activity?: SubscriberActivity;
  /** The task this agent was last seen taking up; absent when none. */
  current?: TaskClaim;
}

/** One `{ok}` result shape for register/heartbeat/unregister. */
export type SubscriberCallResult = { ok: true } | { ok: false; message: string };

export interface SubscriberCallOptions {
  /** Test seam: production uses the bounded fetch. */
  fetchImpl?: FetchTransport;
  /** Per-call budget; defaults to {@link SUBSCRIBER_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * The identity of THIS follower.
 *
 * STABLE when the agent is identifiable, and that is the point (ticket
 * iwibqqek): a per-process random key made every restart a NEW subscriber, so
 * the badge listed the same single agent eight times — eight rows named
 * "agent", all carrying the same delivered event, from eight follower
 * processes started over one session. Re-registering is idempotent by design
 * (the registry keeps `registeredAt`), but only if the key is the same, so the
 * key is derived from the agent identity: `pi-<pid>` is the pi session (a
 * follower restart inside it is the SAME agent) and `$VIBEFLOW_ACTOR` is an
 * explicit name. Different sessions produce different pids, so two real agents
 * stay two rows.
 *
 * With no identity at all the key stays random on purpose: nothing
 * distinguishes those followers, and a shared key would hide the second one.
 * (The pre-fix ghost rows from the shipped 0.28.3 build — which never ran the
 * unregister paths — still expire on their own heartbeat TTL.)
 */
export function createSubscriberIdentity(
  env: NodeJS.ProcessEnv = process.env,
): NotificationSubscriberIdentity {
  const identity = resolveAgentIdentity(env);
  const subscriberId =
    identity.id !== undefined
      ? `sub_${createHash("sha256").update(identity.id).digest("hex").slice(0, 26)}`
      : `sub_${randomUUID()}`;
  const actor = env.VIBEFLOW_ACTOR?.trim();
  return {
    subscriberId,
    agent:
      identity.id ?? (actor !== undefined && actor !== "" ? actor : "agent"),
  };
}

/**
 * The activity a delivered event contributes: its own `type`/`taskId` plus the
 * DELIVERY time. The event's `ts` is deliberately not used for `at` — a
 * follower catching up on an old backlog is active now, and the badge's idle
 * rule asks "has this follower delivered anything lately?", not "how old was
 * the last event?".
 */
export function activityFromEvent(
  event: unknown,
  now: number = Date.now(),
): SubscriberActivity {
  const e = (event ?? {}) as { taskId?: unknown; type?: unknown };
  const activity: SubscriberActivity = { at: now };
  if (typeof e.taskId === "string" && e.taskId !== "") {
    activity.taskId = e.taskId;
  }
  if (typeof e.type === "string" && e.type !== "") {
    activity.type = e.type;
  }
  return activity;
}

/** What one read event does to the follower's "working on" claim. */
export type ClaimUpdate = { current: TaskClaim } | { cleared: true } | null;

/**
 * Read one feed event as a CLAIM signal for `selfAgent`.
 *
 * Only the follower's OWN agent can move its claim: the claim says "the agent
 * in this session is working on task X", so a peer's claim is not ours to
 * carry (that is the per-agent activity, a different field).
 *
 * - `task.claim`, or `task.update` whose `to.status` is `in-progress` → the
 *   task is being taken up NOW; the claim is replaced.
 * - any event that moves a task OUT of in-progress (`review`, `done`, back to
 *   `todo`) → the claim is CLEARED at once rather than left to expire: a
 *   finished agent must not keep saying "working on" for the rest of the TTL.
 * - anything else → no change (a comment on the task does not restart it).
 *
 * The event's `ts` is deliberately not the clock: `at` is when this follower
 * READ the signal, because the claim's lifetime is this process's life.
 */
export function claimUpdateFromEvent(
  event: unknown,
  selfAgent: string | undefined,
  now: number = Date.now(),
): ClaimUpdate {
  if (selfAgent === undefined || selfAgent === "") return null;
  const e = (event ?? {}) as {
    taskId?: unknown;
    agent?: unknown;
    type?: unknown;
    to?: Record<string, unknown>;
  };
  if (e.agent !== selfAgent) return null;
  if (typeof e.taskId !== "string" || e.taskId === "") return null;
  const status = e.to?.["status"];
  const nextStatus = typeof status === "string" ? status : undefined;
  if (e.type === "task.claim" || nextStatus === "in-progress") {
    return { current: { taskId: e.taskId, agent: selfAgent, at: now } };
  }
  if (nextStatus === "review" || nextStatus === "done" || nextStatus === "todo") {
    return { cleared: true };
  }
  return null;
}

function localOrigin(projectDir: string): string {
  // The served port lives in `<project>/.vibeflow/config.json` (default
  // 3700) — the same file `verify` and the screenshot URLs read. `serve`
  // PUBLISHES the port it bound on startup (ticket xy58j31z), so a board on
  // a custom `-p <port>` is discoverable with no follower flag. If the file
  // names a port nobody is serving, registration fails as a dim warning and
  // the heartbeat retries — the feed keeps working either way.
  return `http://localhost:${readConfig(projectDir).port}`;
}

function subscribersUrl(projectDir: string, target: NotificationTarget): string {
  return target === "online"
    ? `${getApiUrl()}${NOTIFICATION_SUBSCRIBERS_V0_PATH}`
    : `${localOrigin(projectDir)}${NOTIFICATION_SUBSCRIBERS_LOCAL_PATH}`;
}

async function onlineHeaders(
  projectDir: string,
): Promise<Record<string, string> | null> {
  const access = await resolveOnlineAccess(projectDir);
  if (!access) return null;
  return {
    Authorization: `Bearer ${access.token}`,
    ...scopeHeaderFor(access.boardId),
  };
}

function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Register a follower, or refresh its heartbeat (the same POST). Idempotent
 * server-side: the badge counts the id once.
 */
export async function registerNotificationSubscriber(
  projectDir: string,
  target: NotificationTarget,
  identity: NotificationSubscriberIdentity,
  opts: SubscriberCallOptions = {},
): Promise<SubscriberCallResult> {
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target === "online") {
    const online = await onlineHeaders(projectDir);
    if (!online) {
      return {
        ok: false,
        message:
          "No board credential for this project — the follower is not registered.",
      };
    }
    headers = { ...online, "Content-Type": "application/json" };
  }
  const url = subscribersUrl(projectDir, target);
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({
      subscriberId: identity.subscriberId,
      agent: identity.agent,
      // Omitted until something was delivered: an absent activity is the
      // honest "no events yet", not a fabricated idle timestamp.
      ...(identity.activity !== undefined ? { activity: identity.activity } : {}),
      // Same rule for the claim: absent is "not working on anything", never a
      // placeholder the board could render as a stale line.
      ...(identity.current !== undefined ? { current: identity.current } : {}),
    }),
  };
  try {
    const res = opts.fetchImpl
      ? await opts.fetchImpl(url, init)
      : // pi-lens-ignore: ts-ssrf — url is getApiUrl()/localhost + a constant path
        await fetchWithTimeout(url, init, {
          phase: "POST (notifications subscriber)",
          timeoutMs: opts.timeoutMs ?? SUBSCRIBER_REQUEST_TIMEOUT_MS,
        });
    if (!res.ok) {
      return {
        ok: false,
        message: `Subscriber registration failed: HTTP ${res.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: `Subscriber registration failed: ${describeFailure(err)}`,
    };
  }
}

/**
 * Remove a follower. Called from the follower's exit path (SIGINT/SIGTERM and
 * every normal return), so a Ctrl-C never leaves a ghost in the badge.
 */
export async function unregisterNotificationSubscriber(
  projectDir: string,
  target: NotificationTarget,
  subscriberId: string,
  opts: SubscriberCallOptions = {},
): Promise<SubscriberCallResult> {
  let headers: Record<string, string> = {};
  if (target === "online") {
    const online = await onlineHeaders(projectDir);
    // Without a credential the server cannot know the board; there is
    // nothing to unsubscribe from (the TTL reaps the entry regardless).
    if (!online) return { ok: false, message: "No board credential." };
    headers = online;
  }
  const url = `${subscribersUrl(projectDir, target)}/${encodeURIComponent(subscriberId)}`;
  try {
    const res = opts.fetchImpl
      ? await opts.fetchImpl(url, { method: "DELETE", headers })
      : // pi-lens-ignore: ts-ssrf — url is getApiUrl()/localhost + a constant path
        await fetchWithTimeout(
          url,
          { method: "DELETE", headers },
          {
            phase: "DELETE (notifications subscriber)",
            timeoutMs: opts.timeoutMs ?? SUBSCRIBER_UNREGISTER_TIMEOUT_MS,
          },
        );
    if (!res.ok) {
      return {
        ok: false,
        message: `Subscriber unregister failed: HTTP ${res.status}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: `Subscriber unregister failed: ${describeFailure(err)}`,
    };
  }
}
