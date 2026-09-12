import React from "react";

const PRIORITY_BADGE_STYLES: Record<
      string,
      { background: string; color: string; border: string }
> = {
      // Chip text colors come from the chip tier so the same badge stays legible
      // on dark, light and high-contrast backgrounds.
      Critical: {
            background: "rgba(239,68,68,0.15)",
            color: "var(--t-chip-red-300)",
            border: "rgba(239,68,68,0.3)",
      },
      High: {
            background: "rgba(249,115,22,0.12)",
            color: "var(--t-chip-orange-400)",
            border: "rgba(249,115,22,0.25)",
      },
      Medium: {
            background: "rgba(234,179,8,0.12)",
            color: "var(--t-chip-amber-400)",
            border: "rgba(234,179,8,0.25)",
      },
      Low: {
            background: "rgba(148,163,184,0.1)",
            color: "var(--t-chip-slate-400)",
            border: "rgba(148,163,184,0.2)",
      },
};

interface Props {
      priority?: string | null;
      style?: React.CSSProperties;
}

export function PriorityBadge({ priority, style }: Props) {
      if (!priority || !PRIORITY_BADGE_STYLES[priority]) return null;
      const colors = PRIORITY_BADGE_STYLES[priority]!;
      return (
            <span
                  style={{
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        padding: "1px 5px",
                        borderRadius: 3,
                        flexShrink: 0,
                        textTransform: "uppercase",
                        background: colors.background,
                        color: colors.color,
                        border: `1px solid ${colors.border}`,
                        lineHeight: "1.5",
                        ...style,
                  }}
            >
                  {priority}
            </span>
      );
}
