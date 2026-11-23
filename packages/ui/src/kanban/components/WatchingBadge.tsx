import React from "react";
import { Eye } from "lucide-react";
import { Button } from "../../primitives";

/**
 * The "Watching" badge (ticket cgor65lmpv31cib1ef9zce5m): how many agents are
 * subscribed to this board's notification feed, and — on click — how many per
 * user name.
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
 * Failure behavior is deliberately quiet: the last good snapshot stays on
 * screen, and the badge renders nothing until the first successful read, so a
 * missing route (an older board) never paints a wrong 0.
 */

/** How often the badge re-reads the registry. TTL is 90 s, heartbeat 30 s. */
export const WATCHING_POLL_INTERVAL_MS = 10_000;

export interface WatchingSnapshot {
  total: number;
  byUser: Array<{ user: string; agents: number }>;
  byAgent: Array<{ agent: string; count: number }>;
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
  return { total: b.total, byUser, byAgent };
}

function agentWord(count: number): string {
  return count === 1 ? "agent" : "agents";
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
    const timer = setInterval(() => void load(), pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [endpoint, headersKey, pollIntervalMs]);

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
          {snapshot.byUser.length === 0 ? (
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
