import React from "react";

/**
 * Needs-attention pill (ticket 0752d55c): amber, verify-badge style — the
 * agent flagged the task and the reason lives in the activity feed.
 * Renders nothing when the task is not flagged, so callers can place it
 * unconditionally next to the other card badges.
 */
interface Props {
      flagged?: boolean;
      style?: React.CSSProperties;
}

export function AttentionBadge({ flagged, style }: Props) {
      if (flagged !== true) return null;
      return (
            <span
                  data-attention-state="flagged"
                  role="img"
                  aria-label="Needs attention"
                  title="Needs attention — the agent flagged this task; the reason is in the activity feed"
                  style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        padding: "1px 6px",
                        borderRadius: 100,
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                        textTransform: "uppercase",
                        background: "rgba(245,158,11,0.14)",
                        color: "var(--t-chip-amber-300)",
                        border: "1px solid rgba(245,158,11,0.35)",
                        lineHeight: "1.5",
                        ...style,
                  }}
            >
                  Needs attention
            </span>
      );
}
