import React from "react";

const STATUS_STYLES: Record<string, { bg: string; color: string; border: string; label: string }> = {
  // SaaS statuses
  todo:        { bg: "rgba(245,158,11,0.14)",  color: "#fcd34d", border: "rgba(245,158,11,0.3)",  label: "Todo" },
  in_progress: { bg: "rgba(59,130,246,0.14)",  color: "#93c5fd", border: "rgba(59,130,246,0.3)",  label: "In Progress" },
  done:        { bg: "rgba(34,197,94,0.12)",   color: "#6ee7b7", border: "rgba(34,197,94,0.28)",  label: "Done" },
  cancelled:   { bg: "rgba(148,163,184,0.1)",  color: "#94a3b8", border: "rgba(148,163,184,0.2)", label: "Cancelled" },
  // CLI statuses
  backlog:       { bg: "rgba(71,85,105,0.14)",  color: "#94a3b8", border: "rgba(71,85,105,0.28)",  label: "Backlog" },
  "in-progress": { bg: "rgba(59,130,246,0.14)",  color: "#93c5fd", border: "rgba(59,130,246,0.3)",  label: "In Progress" },
  review:        { bg: "rgba(168,85,247,0.14)",  color: "#c4b5fd", border: "rgba(168,85,247,0.3)",  label: "Review" },
};

interface Props {
  status: string;
  style?: React.CSSProperties;
}

export function StatusBadge({ status, style }: Props) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.todo;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.03em",
        padding: "2px 7px",
        borderRadius: 4,
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        textTransform: "uppercase",
        ...style,
      }}
    >
      {s.label}
    </span>
  );
}
