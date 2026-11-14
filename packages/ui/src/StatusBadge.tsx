import React from "react";

/**
 * Status colours come from the per-theme `--t-status-*` tokens, never literals.
 *
 * WHY (measured 2026-11-14): this table used to hardcode dark-theme pastels
 * (`#fcd34d`, `#6ee7b7`, `#93c5fd`, `#c4b5fd`). On the light themes they landed
 * on near-white surfaces at 1.10–1.49:1 — invisible text, ten distinct failing
 * colour pairs caught by `scripts/a11y-sweep.mjs`. The tokens already flip per
 * theme (`light` gives #b45309 where `dark` gives #f59e0b), so a theme-aware
 * badge is a token reference rather than four hex literals.
 */
const STATUS_TOKENS: Record<string, { token: string; label: string }> = {
  // SaaS statuses
  todo: { token: "--t-status-todo", label: "Todo" },
  in_progress: { token: "--t-status-progress", label: "In Progress" },
  done: { token: "--t-status-done", label: "Done" },
  cancelled: { token: "--t-status-backlog", label: "Cancelled" },
  // CLI statuses
  backlog: { token: "--t-status-backlog", label: "Backlog" },
  "in-progress": { token: "--t-status-progress", label: "In Progress" },
  review: { token: "--t-status-review", label: "Review" },
};

interface Props {
  status: string;
  style?: React.CSSProperties;
}

export function StatusBadge({ status, style }: Props) {
  const s = STATUS_TOKENS[status] ?? STATUS_TOKENS.todo!;
  const tone = `var(${s.token})`;
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
        // A tint of the SAME token, so the pair always moves together: the
        // literal rgba() pairs could drift from the text colour by hand.
        background: `color-mix(in srgb, ${tone} 14%, transparent)`,
        color: tone,
        border: `1px solid color-mix(in srgb, ${tone} 32%, transparent)`,
        textTransform: "uppercase",
        ...style,
      }}
    >
      {s.label}
    </span>
  );
}
