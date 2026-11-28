import React from "react";
import { Eye } from "lucide-react";
import { Button } from "../../primitives";
import { shortId } from "../task-links";

/**
 * The "Watching" badge (ticket cgor65lmpv31cib1ef9zce5m): who is subscribed
 * to this board's notification feed, and — on click — the live followers with
 * what each one last delivered (ticket ifhh7q2).
 *
 * Read-only by design: registration belongs to the follower
 * (`vibeflow notifications --follow`), never to a browser tab. The badge only
 * reports the registry's live snapshot.
 *
 * The endpoint is a HOST decision, not a shared-UI guess: the local board
 * serves `/api/notifications/subscribers`, the hosted board
 * `/api/v0/notifications/subscribers` with an `X-Vibeflow-Scope` header. Both
 * consumers pass their own URL (+ headers) so this component stays
 * transport-agnostic.
 *
 * Activity wording is derived HERE, never stored: the registry reports the
 * facts (last delivery `at`, heartbeat `lastSeenAt`), and only the reader can
 * decide that a heartbeat with no delivery for a while means "idle, watching".
 * A snapshot from an older board without `subscribers` still renders its
 * per-user counts, so the badge degrades instead of disappearing.
 *
 * Failure behavior is deliberately quiet: the last good snapshot stays on
 * screen, and the badge renders nothing until the first successful read, so a
 * missing route (an older board) never paints a wrong 0.
 */

/** How often the OPEN popover re-reads the registry. TTL is 90 s, heartbeat 30 s.
 *  A closed badge does not poll at all — an idle board must stay silent (the
 *  stage idle gate asserts zero requests over 30 s). */
export const WATCHING_POLL_INTERVAL_MS = 10_000;

/** A live heartbeat with no delivery for this long reads as "idle, watching". */
export const WATCHING_IDLE_AFTER_MS = 5 * 60_000;

/** The last feed event one follower delivered, as the registry reports it. */
export interface WatchingActivity {
  taskId?: string;
  type?: string;
  /** When the follower delivered it (epoch ms). */
  at: number;
}

/** One follower's own free-text status report (mock #2; ticket c9ei8dck7tpcog0wcypddren). */
export interface WatchingStatus {
  /** The agent's report, as the registry stores it. */
  text: string;
  /** When the status was SET (epoch ms) — a heartbeat never refreshes it. */
  at: number;
}

/** One live follower in the badge's list. */
export interface WatchingSubscriber {
  subscriberId: string;
  user: string;
  agent: string;
  registeredAt: number;
  lastSeenAt: number;
  activity?: WatchingActivity;
  /** The agent's own status; absent when it never set one — no line then. */
  status?: WatchingStatus;
}

export interface WatchingSnapshot {
  total: number;
  byUser: Array<{ user: string; agents: number }>;
  byAgent: Array<{ agent: string; count: number }>;
  /** Optional on the wire: an older board answers counts only. */
  subscribers?: WatchingSubscriber[];
}

interface Props {
  /** Board-specific subscribers route (see the module comment). */
  endpoint: string;
  /** Extra request headers (the hosted board's `X-Vibeflow-Scope`). */
  headers?: Record<string, string>;
  /** Test seam; production uses {@link WATCHING_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
}

function snapshotFrom(body: unknown): WatchingSnapshot | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.total !== "number" || !Number.isFinite(b.total)) return null;
  const byUser = Array.isArray(b.byUser)
    ? b.byUser.filter(
        (row): row is { user: string; agents: number } =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as { user?: unknown }).user === "string" &&
          typeof (row as { agents?: unknown }).agents === "number",
      )
    : [];
  const byAgent = Array.isArray(b.byAgent)
    ? b.byAgent.filter(
        (row): row is { agent: string; count: number } =>
          typeof row === "object" &&
          row !== null &&
          typeof (row as { agent?: unknown }).agent === "string" &&
          typeof (row as { count?: unknown }).count === "number",
      )
    : [];
  const subscribers = Array.isArray(b.subscribers)
    ? b.subscribers
        .map(subscriberFrom)
        .filter((row): row is WatchingSubscriber => row !== null)
    : [];
  return { total: b.total, byUser, byAgent, subscribers };
}

function activityFrom(raw: unknown): WatchingActivity | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const a = raw as Record<string, unknown>;
  if (typeof a.at !== "number" || !Number.isFinite(a.at)) return undefined;
  return {
    ...(typeof a.taskId === "string" && a.taskId !== ""
      ? { taskId: a.taskId }
      : {}),
    ...(typeof a.type === "string" && a.type !== "" ? { type: a.type } : {}),
    at: a.at,
  };
}

/**
 * The optional status a row carries (ticket c9ei8dck7tpcog0wcypddren).
 * "Absent stays absent", exactly like {@link activityFrom}: a follower that
 * never sent one gets NO line — never a placeholder the badge invented.
 */
function statusFrom(raw: unknown): WatchingStatus | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.text !== "string" || s.text === "") return undefined;
  if (typeof s.at !== "number" || !Number.isFinite(s.at)) return undefined;
  return { text: s.text, at: s.at };
}

function subscriberFrom(raw: unknown): WatchingSubscriber | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (
    typeof s.subscriberId !== "string" ||
    s.subscriberId === "" ||
    typeof s.user !== "string" ||
    typeof s.agent !== "string" ||
    typeof s.registeredAt !== "number" ||
    typeof s.lastSeenAt !== "number"
  ) {
    return null;
  }
  const activity = activityFrom(s.activity);
  const status = statusFrom(s.status);
  return {
    subscriberId: s.subscriberId,
    user: s.user,
    agent: s.agent,
    registeredAt: s.registeredAt,
    lastSeenAt: s.lastSeenAt,
    ...(activity !== undefined ? { activity } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function agentWord(count: number): string {
  return count === 1 ? "agent" : "agents";
}

/** "12 s ago" — the same wording for every follower row, locale-free. */
function agoLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** What the follower last read: `<user> · <type> · <short task id>`. */
function activityWhat(subscriber: WatchingSubscriber): string {
  const parts = [subscriber.user];
  if (subscriber.activity?.type !== undefined) {
    parts.push(subscriber.activity.type);
  }
  if (subscriber.activity?.taskId !== undefined) {
    parts.push(shortId(subscriber.activity.taskId));
  }
  if (subscriber.activity === undefined) parts.push("no events yet");
  return parts.join(" · ");
}

/**
 * The right-hand slot: delivery age while it is recent, "idle, watching" once
 * a live heartbeat has delivered nothing for {@link WATCHING_IDLE_AFTER_MS}.
 */
function activityWhen(activity: WatchingActivity | undefined, now: number): string {
  if (activity === undefined) return "listening";
  const elapsed = now - activity.at;
  return elapsed > WATCHING_IDLE_AFTER_MS
    ? "idle, watching"
    : agoLabel(elapsed);
}

/**
 * The agent's own status line: uppercase label, the report, its age — amber
 * `--t-agent` soft background per mock #2, inline styles only (this
 * component has no CSS classes; ticket c9ei8dck7tpcog0wcypddren). Past
 * {@link WATCHING_IDLE_AFTER_MS} the line goes muted and reads `idle`: a
 * frozen status would lie, exactly like the activity row's own wording. The
 * caller renders NOTHING when a row has no status — absence is not a line.
 */
function StatusLine({ status, now }: { status: WatchingStatus; now: number }) {
  const elapsed = now - status.at;
  const idle = elapsed > WATCHING_IDLE_AFTER_MS;
  return (
    <div
      style={{
        display: "flex",
        gap: 7,
        alignItems: "flex-start",
        padding: "7px 8px",
        marginTop: 2,
        borderRadius: 8,
        background: "color-mix(in srgb, var(--t-agent) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--t-agent) 22%, transparent)",
        fontSize: 11.5,
        color: idle ? "var(--t-text-faint)" : "var(--t-text-body)",
      }}
    >
      <span
        style={{
          color: idle ? "var(--t-text-muted)" : "var(--t-agent)",
          fontWeight: 700,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          flexShrink: 0,
          paddingTop: 1,
        }}
      >
        status
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {idle ? "idle" : `“${status.text}”`}
      </span>
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          color: "var(--t-text-faint)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {agoLabel(elapsed)}
      </span>
    </div>
  );
}

export function WatchingBadge({
  endpoint,
  headers,
  pollIntervalMs = WATCHING_POLL_INTERVAL_MS,
}: Props) {
  const [snapshot, setSnapshot] = React.useState<WatchingSnapshot | null>(null);
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  // Headers are often inline object literals in the host; keying the effect
  // on their content (not identity) keeps one poll timer, while the ref
  // carries the latest values into the closure.
  const headersKey = JSON.stringify(headers ?? {});
  const headersRef = React.useRef(headers);
  headersRef.current = headers;

  React.useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = async (): Promise<void> => {
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(endpoint, {
          headers: headersRef.current,
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body: unknown = await res.json();
        const next = snapshotFrom(body);
        if (!cancelled && next !== null) setSnapshot(next);
      } catch {
        /* transient (offline, aborted, older board): keep the last count */
      }
    };
    void load();
    // Poll ONLY while the popover is open (ticket rc1fzqni's stage gate).
    //
    // This used to poll every 10 s forever, which broke the board's idle
    // contract — `stage-board-idle.spec.ts` asserts ZERO requests during 30 s
    // of idling and caught `/api/v0/notifications/subscribers` in the act. A
    // badge nobody is looking at has no reason to ask: the first read paints
    // the pill, opening the popover refreshes it, and while it is open the
    // numbers stay live.
    if (!open) {
      return () => {
        cancelled = true;
        controller?.abort();
      };
    }
    const timer = setInterval(() => void load(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [endpoint, headersKey, pollIntervalMs, open]);

  // Close on outside click / Escape — a popover that traps the pointer is
  // worse than no popover on a phone.
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (snapshot === null) return null;

  const label = `Watching ${snapshot.total} ${agentWord(snapshot.total)}`;
  const subscribers = snapshot.subscribers ?? [];
  // One clock for the whole popover: every row's "12 s ago" agrees.
  const now = Date.now();

  return (
    <div ref={containerRef} style={{ position: "relative", flexShrink: 0 }}>
      <Button
        id="watching-badge"
        type="button"
        variant="ghost"
        size="sm"
        className="kb-action-btn gap-1.5 h-7 rounded-lg px-2.5"
        title="Agents following this board's notification feed"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        style={{ whiteSpace: "nowrap", fontSize: 11, fontWeight: 500 }}
      >
        <Eye className="w-3.5 h-3.5" aria-hidden="true" />
        <span className="kb-watching-label">Watching</span>
        <span id="watching-badge-count">{snapshot.total}</span>
      </Button>

      {open && (
        <div
          id="watching-popover"
          role="dialog"
          aria-label="Agents following this board"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 220,
            maxWidth: 280,
            background: "var(--t-card)",
            border: "1px solid var(--t-border-strong)",
            borderRadius: 10,
            boxShadow: "var(--t-shadow-lg)",
            padding: "10px 12px",
            zIndex: 60,
          }}
        >
          <div
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--t-text-body)",
              marginBottom: 8,
            }}
          >
            Watching this board
          </div>
          {subscribers.length > 0
            ? subscribers.map((subscriber) => {
                const when = activityWhen(subscriber.activity, now);
                return (
                  <div
                    key={subscriber.subscriberId}
                    style={{ padding: "4px 0", fontSize: 12 }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <span
                        title={`${subscriber.agent} · ${subscriber.user}`}
                        style={{
                          color: "var(--t-text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {subscriber.agent}
                      </span>
                      <span
                        style={{
                          color:
                            when === "idle, watching"
                              ? "var(--t-text-faint)"
                              : "var(--t-text-muted)",
                          whiteSpace: "nowrap",
                          flexShrink: 0,
                        }}
                      >
                        {when}
                      </span>
                    </div>
                    <div
                      style={{
                        color: "var(--t-text-faint)",
                        fontSize: 11,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {activityWhat(subscriber)}
                    </div>
                    {subscriber.status !== undefined && (
                      <StatusLine status={subscriber.status} now={now} />
                    )}
                  </div>
                );
              })
            : snapshot.byUser.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--t-text-muted)" }}>
                  No agents are following this board.
                </div>
              ) : (
                snapshot.byUser.map((row) => (
                  <div
                    key={row.user}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "4px 0",
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        color: "var(--t-text)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.user}
                    </span>
                    <span
                      style={{
                        color: "var(--t-text-muted)",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {row.agents} {agentWord(row.agents)}
                    </span>
                  </div>
                ))
              )}
          <div
            style={{
              marginTop: 8,
              paddingTop: 6,
              borderTop: "1px solid var(--t-border)",
              fontSize: 10,
              color: "var(--t-text-faint)",
            }}
          >
            {snapshot.total} {agentWord(snapshot.total)} following
          </div>
        </div>
      )}
    </div>
  );
}
