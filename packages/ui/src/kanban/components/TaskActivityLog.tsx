import React from "react";

/**
 * Per-task activity log (ticket ylgq1p5o): the board's notification feed,
 * narrowed to ONE task, rendered as a chronological record of what happened.
 *
 * It is a read-only log on purpose. Every row is a delivered event — a fact
 * that already happened — and every row carries its age. The header carries
 * the age of the last successful read, so a list that stopped refreshing says
 * how old it is instead of posing as live. That is the same honesty rule the
 * Watching badge follows (a follower can report what it DELIVERED, never what
 * an agent intended), moved to its simplest form: nothing here can outlive
 * the process that wrote it, because nothing here claims anything is still
 * happening.
 *
 * The task scoping is SERVER-SIDE (`?taskId=`, ticket p3tkodry) so a busy
 * board does not ship every task's events to each open panel. An older board
 * ignores the unknown dimension and widens (the p3tkodry rule) — so the rows
 * are ALSO filtered here by `taskId`: a newer panel against an older board
 * shows this task's events, never a mixed feed.
 *
 * Transport-agnostic like the Watching badge: the host passes the feed
 * endpoint (+ the hosted board's scope header). Unwired host = no log, never
 * a guessed route.
 */

/** Default page size — one panel does not need the whole board's history. */
export const TASK_ACTIVITY_LOG_LIMIT = 20;

/** How often the OPEN log re-reads. A closed panel unmounts it (no polling). */
export const TASK_ACTIVITY_LOG_POLL_MS = 10_000;

/**
 * How long a "working on" claim stays credible (ticket qxvptxkta).
 *
 * The board already drops expired claims, so this is the SECOND guard, for the
 * one case the board cannot cover: a clock that ran backwards or a claim that
 * arrives stale from an older/hosted board. Past this age the line reads
 * `idle, watching` — the same vocabulary the Watching badge uses — because a
 * claim that old is no evidence of work, and printing its age would be a
 * frozen "working on X".
 *
 * Duplicated from the CLI registry on purpose: the UI package cannot import
 * the CLI, exactly like the payload shapes it mirrors.
 */
export const TASK_ACTIVITY_CLAIM_TTL_MS = 90_000;

/** One feed event, as this log reads it — the fields it renders, nothing more. */
export interface TaskActivityEvent {
  id: string;
  /** ISO-8601 with ms (the feed's `ts`). */
  ts: string;
  type: string;
  taskId: string;
  /** Reader-facing label: "agent" | "board" | a user/actor name. */
  actor: string;
  /** Agent identity, when the writer had one — the more specific label. */
  agent?: string;
  /** Field names the mutation touched, when the emitter knew them. */
  changed?: string[];
  /** New values of the changed fields only. */
  to?: Record<string, unknown>;
}

interface Props {
  /** Board-specific feed route (see the module comment). */
  endpoint: string;
  /** Extra request headers (the hosted board's `X-Vibeflow-Scope`). */
  headers?: Record<string, string>;
  taskId: string;
  /** Page size asked of the feed; the newest N win. */
  limit?: number;
  /** Test seam; production uses {@link TASK_ACTIVITY_LOG_POLL_MS}. */
  pollIntervalMs?: number;
}

/** "12 s ago" — the wording the Watching badge already uses, locale-free. */
export function agoLabel(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const VERBS: Record<string, string> = {
  "task.create": "created",
  "task.update": "updated",
  "task.claim": "claimed",
  "task.delete": "deleted",
  "task.comment": "commented",
  "task.file": "changed files",
  verify: "verified",
};

/** What happened: a known verb, or the raw type — never an invented one. */
export function eventVerb(type: string): string {
  return VERBS[type] ?? type;
}

/** The changed fields (and a status target when the event carries one). */
export function eventDetail(event: TaskActivityEvent): string {
  const parts: string[] = [];
  if (event.changed !== undefined && event.changed.length > 0) {
    parts.push(event.changed.join(", "));
  }
  const status = event.to?.["status"];
  if (typeof status === "string" && status !== "") parts.push(`→ ${status}`);
  return parts.join(" · ");
}

function eventFrom(raw: unknown): TaskActivityEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    e.id === "" ||
    typeof e.ts !== "string" ||
    typeof e.type !== "string" ||
    typeof e.taskId !== "string" ||
    typeof e.actor !== "string"
  ) {
    return null;
  }
  const changed = Array.isArray(e.changed)
    ? e.changed.filter((f): f is string => typeof f === "string")
    : undefined;
  const to =
    typeof e.to === "object" && e.to !== null
      ? (e.to as Record<string, unknown>)
      : undefined;
  return {
    id: e.id,
    ts: e.ts,
    type: e.type,
    taskId: e.taskId,
    actor: e.actor,
    ...(typeof e.agent === "string" && e.agent !== ""
      ? { agent: e.agent }
      : {}),
    ...(changed !== undefined ? { changed } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

/** A live "working on" claim, as the feed answer reports it. */
export interface TaskActivityClaim {
  taskId: string;
  /** The agent that caused the work, not the reader that reported it. */
  agent: string;
  /** When the claiming follower delivered the work signal (epoch ms). */
  at: number;
}

interface FeedAnswer {
  events: TaskActivityEvent[];
  /** The feed evicted events before the window it could serve. */
  gap: boolean;
  /** Who is working on THIS task right now, or null — never a stale claim. */
  claim: TaskActivityClaim | null;
}

function claimFrom(raw: unknown, taskId: string, now: number): TaskActivityClaim | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (c.taskId !== taskId) continue;
    if (typeof c.agent !== "string" || c.agent === "") continue;
    if (typeof c.at !== "number" || !Number.isFinite(c.at) || c.at <= 0) continue;
    // Expired is the same as absent: the point of the whole feature is that a
    // claim cannot outlive the writer that kept it fresh.
    if (now - c.at >= TASK_ACTIVITY_CLAIM_TTL_MS) return null;
    return { taskId, agent: c.agent, at: c.at };
  }
  return null;
}

function feedAnswerFrom(raw: unknown, taskId: string): FeedAnswer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.notifications)) return null;
  const events = body.notifications
    .map(eventFrom)
    .filter((e): e is TaskActivityEvent => e !== null)
    // Older board: the unknown `taskId` dimension widened the read. Keep
    // this task's events only, so the panel never mixes two tasks.
    .filter((e) => e.taskId === taskId);
  // Newest first — the row nearest the header is the most recent fact.
  events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return {
    events,
    gap: body.gap === true,
    claim: claimFrom(body.current, taskId, Date.now()),
  };
}

const ROW_TEXT: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function TaskActivityLog({
  endpoint,
  headers,
  taskId,
  limit = TASK_ACTIVITY_LOG_LIMIT,
  pollIntervalMs = TASK_ACTIVITY_LOG_POLL_MS,
}: Props) {
  // `null` = no successful read yet, so the first paint is loading, not empty.
  const [answer, setAnswer] = React.useState<FeedAnswer | null>(null);
  const [failed, setFailed] = React.useState(false);
  /** When the last read SETTLED (success or failure) — the header's age. */
  const [lastReadAt, setLastReadAt] = React.useState<number | null>(null);
  // Out-of-order guard (ticket d6hkvg4v's pattern): a response for the task
  // that was open when the request started must never paint the task now in
  // front of the user. Every load takes a generation; a newer task/open wins.
  const loadGen = React.useRef(0);
  // The task this component is showing, for the fetch URL + write guard.
  const taskIdRef = React.useRef(taskId);
  const headersKey = JSON.stringify(headers ?? {});
  const headersRef = React.useRef(headers);
  headersRef.current = headers;

  React.useEffect(() => {
    taskIdRef.current = taskId;
    // A new task starts from loading: the previous task's rows are not this
    // task's history, so they are cleared rather than carried over.
    setAnswer(null);
    setFailed(false);
    setLastReadAt(null);
    let cancelled = false;
    let controller: AbortController | null = null;

    const load = async (): Promise<void> => {
      const gen = ++loadGen.current;
      const asked = taskIdRef.current;
      controller?.abort();
      controller = new AbortController();
      try {
        const url = `${endpoint}?taskId=${encodeURIComponent(asked)}&limit=${limit}`;
        const res = await fetch(url, {
          headers: headersRef.current,
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!cancelled && loadGen.current === gen) {
            setFailed(true);
            setLastReadAt(Date.now());
          }
          return;
        }
        const body: unknown = await res.json();
        const next = feedAnswerFrom(body, asked);
        if (cancelled || loadGen.current !== gen) return;
        setLastReadAt(Date.now());
        if (next === null) {
          // An unreadable answer is a failed read, not an empty log.
          setFailed(true);
          return;
        }
        setAnswer(next);
        setFailed(false);
      } catch {
        if (!cancelled && loadGen.current === gen) {
          setFailed(true);
          setLastReadAt(Date.now());
        }
      }
    };

    void load();
    const timer = setInterval(() => void load(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
      // Invalidate whatever is in flight so a late answer from this task
      // cannot land after the cleanup.
      loadGen.current += 1;
    };
  }, [endpoint, taskId, limit, pollIntervalMs, headersKey]);

  const events = answer?.events ?? [];
  const now = Date.now();

  return (
    <div id="dp-log-section" style={{ marginTop: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          borderTop: "1px solid var(--t-border)",
          paddingTop: 10,
        }}
      >
        <span
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--t-text-body)",
            flex: 1,
          }}
        >
          Activity log
        </span>
        {/* The age of the READ, not of the newest row: a list that stopped
            refreshing must not look live. */}
        {lastReadAt !== null && (
          <span
            id="dp-log-read-age"
            title="When this log was last read from the feed"
            style={{
              fontSize: 10,
              color: failed ? "var(--t-danger-strong)" : "var(--t-text-faint)",
              whiteSpace: "nowrap",
            }}
          >
            {failed
              ? `couldn't refresh — read ${agoLabel(now - lastReadAt)}`
              : `read ${agoLabel(now - lastReadAt)}`}
          </span>
        )}
      </div>

      {/* "Working on" (ticket qxvptxkta). It is a CLAIM, so it is rendered
          as one: an agent name plus how long ago the claim was delivered, and
          `idle, watching` the moment the board stops reporting it. Never a
          claim without a sender, never a stale one with a minute count. */}
      <p
        id="dp-log-current"
        data-state={answer?.claim ? "working" : "idle"}
        style={{
          fontSize: 10,
          padding: "4px 0 0",
          color: answer?.claim
            ? "var(--t-text-body)"
            : "var(--t-text-faint)",
        }}
      >
        {answer === null
          ? "…"
          : answer.claim === null
            ? "idle, watching"
            : `${answer.claim.agent} working on this task · ${agoLabel(now - answer.claim.at)}`}
      </p>

      {answer === null ? (
        failed ? (
          <p
            id="dp-log-stale"
            style={{
              color: "var(--t-danger-strong)",
              fontSize: 11,
              padding: "6px 0",
            }}
          >
            Couldn’t read the activity log.
          </p>
        ) : (
          <p
            id="dp-log-loading"
            role="status"
            aria-label="Reading activity"
            style={{
              color: "var(--t-text-faint)",
              fontSize: 11,
              padding: "6px 0",
            }}
          >
            Reading activity…
          </p>
        )
      ) : (
        <>
          {answer.gap && (
            <p
              id="dp-log-gap"
              style={{
                color: "var(--t-text-faint)",
                fontSize: 10,
                padding: "4px 0 0",
              }}
            >
              Older activity may have been evicted from the feed.
            </p>
          )}
          {events.length === 0 ? (
            <p
              id="dp-log-empty"
              style={{
                color: "var(--t-text-body)",
                fontSize: 11,
                padding: "6px 0",
              }}
            >
              No activity for this task yet.
            </p>
          ) : (
            <ul
              id="dp-log-rows"
              style={{
                listStyle: "none",
                margin: "4px 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 2,
                maxHeight: 160,
                overflowY: "auto",
              }}
            >
              {events.map((event) => {
                const detail = eventDetail(event);
                const when = Date.parse(event.ts);
                return (
                  <li
                    key={event.id}
                    id={`dp-log-${event.id}`}
                    title={event.ts}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      fontSize: 11,
                      padding: "2px 0",
                    }}
                  >
                    <span style={{ color: "var(--t-text)", flexShrink: 0 }}>
                      {event.agent ?? event.actor}
                    </span>
                    <span style={{ ...ROW_TEXT, color: "var(--t-text-muted)", flex: 1 }}>
                      {eventVerb(event.type)}
                      {detail !== "" ? ` ${detail}` : ""}
                    </span>
                    <span
                      style={{
                        color: "var(--t-text-faint)",
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {Number.isNaN(when) ? "" : agoLabel(now - when)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
