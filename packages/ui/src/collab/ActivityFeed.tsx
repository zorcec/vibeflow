"use client";

import React from "react";
import { X, Activity } from "lucide-react";
import { UserAvatar } from "./UserAvatar";
import { AgentBadge } from "../kanban";
import { collapseCreateBursts, feedActorForTask, type FeedTask } from "./feed";
import { isAgentOrigin } from "./feed";

interface ActivityEvent {
  id: string;
  time: string;
  user: string;
  action: string;
  detail: string;
  // Ticket f286acdc: set only on collapsed bulk-push rows (`pushed`).
  count?: number;
  /** Agent-involvement flag (0b7c45c5): set where the actor is known.
   * Created rows badge from the stamped `createOrigin` (agent-icon
   * tickets) — NULL/unknown renders unbadged, exactly like before. */
  isAgent?: boolean;
}

export interface StatusChangeEvent {
  id: string;
  taskId: string;
  taskTitle: string;
  previousStatus?: string;
  newStatus: string;
  user: string;
  /** Agent-involvement flag (0b7c45c5): set where the actor is known. Absent = unknown = unbadged. */
  isAgent?: boolean;
  time: string;
}

/** Generic activity log entry for events beyond status changes (comments, field updates). */
export interface ActivityLogEntry {
  id: string;
  taskId: string;
  taskTitle: string;
  user: string;
  /** Agent-involvement flag (0b7c45c5): set where the actor is known. Absent = unknown = unbadged. */
  isAgent?: boolean;
  time: string;
  // `resynced` marks a client-side reconnect resync (ticket cb3d0506):
  // no task changed, the board re-fetched after the socket dropped.
  action: 'commented' | 'updated' | 'deleted-comment' | 'attached' | 'resynced';
  detail?: string;
}

const STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  "in-progress": "In Progress",
  review: "Review",
  done: "Done",
};

interface ActivityGroup {
  user: string;
  /** True when the group's rows came through an agent surface (badged). */
  isAgent: boolean;
  newestTime: string;
  oldestTime: string;
  events: ActivityEvent[];
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// currentUser is NOT a parameter: it was threaded through and never read
// (the feed labels rows from each task's recorded actor). The props that
// expose it stay, because callers pass it and the counter still needs it.
function buildEvents(tasks: FeedTask[], statusChangeLog: StatusChangeEvent[] = [], activityLog: ActivityLogEntry[] = []): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const task of tasks) {
    if (task.createdAt) {
      const t = new Date(task.createdAt).getTime();
      if (t > cutoff) {
        events.push({
          id: `created-${task.id}`,
          time: task.createdAt,
          // Ticket tm6p4urj: recorded push actor first, stored author as
          // the legacy fallback — a push of someone else's record names
          // the pusher without rewriting the authoritative author.
          user: feedActorForTask(task),
          action: "created",
          detail: task.title,
          // Agent-icon tickets: the stamped create surface badges the
          // row — a CLI/API-created task renders its human WITH the
          // agent badge, live and after refetch. NULL/legacy stays
          // unbadged (today's rendering, unchanged).
          ...(isAgentOrigin(task.createOrigin) ? { isAgent: true as const } : {}),
        });
      }
    }
  }

  for (const sc of statusChangeLog) {
    const t = new Date(sc.time).getTime();
    if (t > cutoff) {
      events.push({
        id: sc.id,
        time: sc.time,
        user: sc.user,
        action: "moved",
        detail: `${sc.taskTitle} → ${STATUS_LABELS[sc.newStatus] ?? sc.newStatus}`,
        ...(sc.isAgent !== undefined ? { isAgent: sc.isAgent } : {}),
      });
    }
  }

  for (const entry of activityLog) {
    const t = new Date(entry.time).getTime();
    if (t > cutoff) {
      events.push({
        id: entry.id,
        time: entry.time,
        user: entry.user,
        action: entry.action,
        detail: entry.detail ?? entry.taskTitle,
        ...(entry.isAgent !== undefined ? { isAgent: entry.isAgent } : {}),
      });
    }
  }

  // Ticket f286acdc: collapse bulk-push bursts BEFORE the 40-row cap so a
  // 60-task push costs one row, not the whole feed. Newest-first in,
  // newest-first out — the sort above is the contract `collapseCreateBursts`
  // requires.
  return collapseCreateBursts(events.sort((a, b) => b.time.localeCompare(a.time))).slice(0, 40);
}

function groupConsecutive(events: ActivityEvent[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    // Attribution (0b7c45c5): agent and human rows by the same human stay
    // in separate groups — a merged group would badge (or unbadge) rows
    // that do not share the flag.
    if (last && last.user === event.user && last.isAgent === (event.isAgent ?? false)) {
      last.events.push(event);
      // oldest time is the smaller timestamp
      if (event.time < last.oldestTime) last.oldestTime = event.time;
    } else {
      groups.push({
        user: event.user,
        isAgent: event.isAgent ?? false,
        newestTime: event.time,
        oldestTime: event.time,
        events: [event],
      });
    }
  }
  return groups;
}

function getActiveUsers(tasks: FeedTask[], currentUser: string, statusChangeLog: StatusChangeEvent[] = [], activityLog: ActivityLogEntry[] = []): string[] {
  const fiveMin = Date.now() - 5 * 60 * 1000;
  const events = buildEvents(tasks, statusChangeLog, activityLog);
  const users = new Set<string>();
  for (const ev of events) {
    if (new Date(ev.time).getTime() > fiveMin) {
      users.add(ev.user);
    }
  }
  // Always include current user if they have any session (viewing = active)
  users.add(currentUser);
  return [...users];
}

const ACTION_COLORS: Record<string, string> = {
  created: "var(--p-green)",
  // Ticket f286acdc: the aggregate row keeps the created hue — a push IS
  // a batch of creates, not a new kind of work.
  pushed: "var(--p-green)",
  updated: "var(--p-blue)",
  commented: "var(--p-purple)",
  moved: "var(--p-amber)",
  "deleted-comment": "var(--p-red, #ef4444)",
  attached: "var(--p-teal, #14b8a6)",
  resynced: "var(--p-blue-300, #93c5fd)",
};

interface ActivityGroupRowProps {
  group: ActivityGroup;
}

function ActivityGroupRow({ group }: ActivityGroupRowProps) {
  const timeLabel =
    group.events.length === 1
      ? formatTime(group.newestTime)
      : `${formatTime(group.newestTime)}`;

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 16px" }}>
      <div style={{ marginTop: 1 }}>
        <UserAvatar user={group.user} size={22} fontSize={9} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--p-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160, display: "inline-flex", alignItems: "center", gap: 4 }} title={group.isAgent ? `${group.user} (via agent)` : group.user}>
            {group.user}
            {group.isAgent && <AgentBadge human={group.user} />}
          </span>
          <span style={{ fontSize: 9.5, color: "var(--p-text-g)", flexShrink: 0, marginLeft: 6 }}>
            {timeLabel}
          </span>
        </div>
        <div style={{ borderLeft: "1.5px solid var(--p-border)", paddingLeft: 8 }}>
          {group.events.map((ev) => (
            <div key={ev.id} style={{ display: "flex", alignItems: "flex-start", gap: 5, padding: "2px 0" }}>
              <div
                style={{
                  width: 5, height: 5, borderRadius: "50%",
                  background: ACTION_COLORS[ev.action] ?? "var(--p-text-g)",
                  flexShrink: 0, marginTop: 4,
                }}
              />
              <span
                style={{
                  fontSize: 9.5, fontWeight: 600, padding: "0px 4px",
                  borderRadius: 3, letterSpacing: "0.03em",
                  background: `${ACTION_COLORS[ev.action] ?? "var(--p-text-g)"}1a`,
                  color: ACTION_COLORS[ev.action] ?? "var(--p-text-g)",
                  flexShrink: 0, textTransform: "capitalize",
                }}
              >
                {ev.action}
              </span>
              <span
                style={{
                  fontSize: 11, color: "var(--p-text-f)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  flex: 1, minWidth: 0,
                }}
                title={ev.detail}
              >
                {ev.detail}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface Props {
  tasks: FeedTask[];
  currentUser: string;
  onClose: () => void;
  statusChangeLog?: StatusChangeEvent[];
  activityLog?: ActivityLogEntry[];
}

export function ActivityFeedPanel({ tasks, currentUser, onClose, statusChangeLog, activityLog }: Props) {
  const groups = React.useMemo(() => {
    const events = buildEvents(tasks, statusChangeLog, activityLog);
    return groupConsecutive(events);
  }, [tasks, currentUser, statusChangeLog, activityLog]);

  return (
    <div
      id="activity-feed-panel"
      style={{
        width: "100%", flexShrink: 0, display: "flex", flexDirection: "column",
        borderLeft: "1px solid var(--p-border)", background: "var(--p-surface)",
        height: "100%", overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px", borderBottom: "1px solid var(--p-border)", flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Activity style={{ width: 14, height: 14, color: "var(--p-blue-300)" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--p-text)" }}>Activity</span>
        </div>
        <button
          id="activity-feed-close"
          onClick={onClose}
          title="Close activity feed"
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--p-text-g)", padding: 4, display: "flex", borderRadius: 5,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--p-text-m)"; e.currentTarget.style.background = "var(--p-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--p-text-g)"; e.currentTarget.style.background = "none"; }}
        >
          <X style={{ width: 14, height: 14 }} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {groups.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--p-text-g)", textAlign: "center", padding: "24px 16px" }}>
            No recent activity.
          </p>
        ) : (
          groups.map((group, i) => (
            <React.Fragment key={`${group.user}-${group.newestTime}-${i}`}>
              {i > 0 && (
                <div style={{ margin: "2px 16px", borderTop: "1px solid var(--p-border)" }} />
              )}
              <ActivityGroupRow group={group} />
            </React.Fragment>
          ))
        )}
      </div>
    </div>
  );
}

interface ActivityCounterProps {
  tasks: FeedTask[];
  currentUser: string;
  lastCheckAt?: string | null;
  onClick: () => void;
  statusChangeLog?: StatusChangeEvent[];
  activityLog?: ActivityLogEntry[];
  /** Names of users currently connected via WebSocket (live presence). */
  connectedUsers?: string[];
}

export function ActivityCounter({ tasks, currentUser, lastCheckAt, onClick, statusChangeLog, activityLog, connectedUsers = [] }: ActivityCounterProps) {
  const activeUsers = React.useMemo(() => {
    const fromEvents = getActiveUsers(tasks, currentUser, statusChangeLog, activityLog);
    const combined = new Set(fromEvents);
    for (const u of connectedUsers) combined.add(u);
    return [...combined];
  }, [tasks, currentUser, statusChangeLog, activityLog, connectedUsers]);
  const unseenCount = React.useMemo(() => {
    // Count tasks with activity since the user last opened the feed.
    // Fall back to last 7 days if they've never opened it.
    const cutoff = lastCheckAt ? new Date(lastCheckAt).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;
    // `activityLog` belongs here too: comments, field updates and attachments
    // are events the panel shows, so omitting them made the badge under-count
    // (and the memo never re-ran when the log changed).
    const events = buildEvents(tasks, statusChangeLog, activityLog);
    return events.filter(ev => new Date(ev.time).getTime() > cutoff).length;
  }, [tasks, lastCheckAt, statusChangeLog, activityLog]);

  return (
    <button
      id="activity-counter"
      onClick={onClick}
      title="Open activity feed"
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 10px", borderRadius: 100,
        background: "color-mix(in srgb, var(--p-blue) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--p-blue) 28%, transparent)",
        color: "var(--p-blue-300)", cursor: "pointer",
        fontSize: 12, fontWeight: 500, flexShrink: 0, transition: "all .12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "color-mix(in srgb, var(--p-blue) 22%, transparent)";
        e.currentTarget.style.borderColor = "color-mix(in srgb, var(--p-blue) 45%, transparent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "color-mix(in srgb, var(--p-blue) 12%, transparent)";
        e.currentTarget.style.borderColor = "color-mix(in srgb, var(--p-blue) 28%, transparent)";
      }}
    >
      <span>{activeUsers.length} active</span>
      {unseenCount > 0 && (
        <span
          data-role="activity-unseen"
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            minWidth: 16, height: 16, padding: "0 4px", borderRadius: 100,
            background: "var(--p-blue)", color: "#fff", fontSize: 10, fontWeight: 700,
          }}
        >
          {unseenCount}
        </span>
      )}
    </button>
  );
}

