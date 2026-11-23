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
 */

import { randomUUID } from "node:crypto";
import { scopeHeaderFor } from "../auth/board-scope.js";
import { fetchWithTimeout } from "../saas/request.js";
import { getApiUrl } from "./api-url.js";
import { readConfig } from "./config.js";
import {
  resolveOnlineAccess,
  type FetchTransport,
  type NotificationTarget,
} from "./notifications-fetch.js";

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

export interface NotificationSubscriberIdentity {
  /** `sub_` + a random UUID; unique per follower process. */
  subscriberId: string;
  /** `$VIBEFLOW_ACTOR`, else "agent" — the event actor rule. */
  agent: string;
}

/** One `{ok}` result shape for register/heartbeat/unregister. */
export type SubscriberCallResult = { ok: true } | { ok: false; message: string };

export interface SubscriberCallOptions {
  /** Test seam: production uses the bounded fetch. */
  fetchImpl?: FetchTransport;
  /** Per-call budget; defaults to {@link SUBSCRIBER_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The stable identity of THIS follower process. */
export function createSubscriberIdentity(
  env: NodeJS.ProcessEnv = process.env,
): NotificationSubscriberIdentity {
  const actor = env.VIBEFLOW_ACTOR?.trim();
  return {
    subscriberId: `sub_${randomUUID()}`,
    agent: actor !== undefined && actor !== "" ? actor : "agent",
  };
}

function localOrigin(projectDir: string): string {
  // The served port lives in `<project>/.vibeflow/config.json` (default
  // 3700) — the same file `verify` and the screenshot URLs read. A board
  // started on a non-default port is not discoverable here; the heartbeat
  // retries, so a later match still registers.
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
