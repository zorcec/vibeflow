import React from "react";

const TYPE_BADGE_STYLES: Record<string, { background: string; color: string; border: string }> = {
  Bug:      { background: "rgba(239,68,68,0.12)",   color: "#f87171", border: "rgba(239,68,68,0.25)" },
  Research: { background: "rgba(192,132,252,0.12)", color: "#c084fc", border: "rgba(139,92,246,0.2)" },
  Task:     { background: "rgba(148,163,184,0.1)",  color: "#94a3b8", border: "rgba(148,163,184,0.2)" },
};

interface Props {
  type?: unknown;
  style?: React.CSSProperties;
}

export function TypeBadge({ type, style }: Props) {
  const effectiveType =
    typeof type === "string" && type.trim() && type !== "[object Object]" && TYPE_BADGE_STYLES[type]
      ? type
      : "Task";
  const colors = TYPE_BADGE_STYLES[effectiveType]!;
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
      {effectiveType}
    </span>
  );
}
