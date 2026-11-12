import React from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn, cva, type VariantProps } from "../primitives";

/**
 * Badge — the label primitive.
 *
 * Token contract (AGENTS.md "Tokens only"): every colour resolves through
 * `src/primitives/theme.css`, so all six themes restyle the badge with no
 * per-theme markup and no hex values.
 *
 * WHY THE `tone` MAP EXISTS
 * `packages/ui` already ships four bespoke badges (`StatusBadge`, `TypeBadge`,
 * `PriorityBadge`, `AttentionBadge`), and their colours are pinned by
 * `kanban/components/__tests__/StatusBadgeColors.test.ts` (canonical map:
 * backlog slate, todo amber, in-progress blue, review purple, done green — the
 * `--t-chip-*` / `--t-status-*` tiers). This primitive must be able to express
 * exactly those hues, or the migration in P16 would have to change the visuals
 * of working components. The tone names below therefore map 1:1 onto the
 * existing token names, and `badge.test.tsx` proves it by asserting the exact
 * token each tone resolves to — the same token the old badge's test names.
 */
const badgeStyles = cva(
  "inline-flex items-center gap-1 rounded border font-semibold uppercase tracking-wide whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-border bg-bg-raised text-text",
        secondary: "border-border-strong bg-hover text-text-muted",
        outline: "border-border-strong bg-transparent text-text",
        danger: "border-danger bg-danger-soft text-danger",
      },
      size: {
        sm: "px-1.5 py-0.5 text-xs",
        md: "px-2 py-0.5 text-sm",
      },
      /**
       * Semantic tones. These override only colour (variant/size keep their
       * geometry), because `cn` merges with tailwind-merge and `tone` is passed
       * last — a tone must never silently change padding or radius.
       */
      tone: {
        // ── status: the canonical board-column hues ────────────────────────
        "status-backlog": "border-status-backlog/30 bg-status-backlog/14 text-chip-slate-400",
        "status-todo": "border-status-todo/30 bg-status-todo/14 text-chip-amber-300",
        "status-progress": "border-status-progress/30 bg-status-progress/14 text-chip-blue-200",
        "status-review": "border-status-review/30 bg-status-review/14 text-chip-purple-300",
        "status-done": "border-status-done/28 bg-status-done/12 text-chip-green-400",
        // ── priority: PriorityBadge's map ─────────────────────────────────
        "priority-low": "border-border bg-bg-raised text-chip-slate-400",
        "priority-medium": "border-status-todo/30 bg-status-todo/14 text-chip-amber-400",
        "priority-high": "border-status-todo/30 bg-status-todo/14 text-chip-orange-400",
        "priority-urgent": "border-status-review/30 bg-status-review/14 text-chip-red-300",
        // ── type: TypeBadge's map ─────────────────────────────────────────
        "type-feature": "border-status-review/30 bg-status-review/14 text-chip-purple-300",
        "type-bug": "border-status-review/30 bg-status-review/14 text-chip-red-300",
        "type-chore": "border-border bg-bg-raised text-chip-slate-400",
        // ── attention: AttentionBadge's hue ───────────────────────────────
        attention: "border-status-todo/30 bg-status-todo/14 text-chip-amber-300",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export type BadgeVariant = VariantProps<typeof badgeStyles>["variant"];
export type BadgeSize = VariantProps<typeof badgeStyles>["size"];
export type BadgeTone = VariantProps<typeof badgeStyles>["tone"];

/** Every tone key, exported so the story matrix and the parity test iterate the
 * real set instead of a hand-kept copy. */
export const BADGE_TONES = [
  "status-backlog",
  "status-todo",
  "status-progress",
  "status-review",
  "status-done",
  "priority-low",
  "priority-medium",
  "priority-high",
  "priority-urgent",
  "type-feature",
  "type-bug",
  "type-chore",
  "attention",
] as const satisfies readonly NonNullable<BadgeTone>[];

export interface BadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Container variant. Every key here needs a story (see STORY_MATRIX). */
  variant?: BadgeVariant;
  /** Size step. Every key here needs a story (see STORY_MATRIX). */
  size?: BadgeSize;
  /** Semantic colour tone; overrides the variant's colour only. */
  tone?: BadgeTone;
  /** Decorative leading dot (aria-hidden — the label carries the meaning). */
  dot?: boolean;
  /** Label text. Never colour-only: the text is the accessible name. */
  children: ReactNode;
  /** Extra classes, merged last via `cn`. */
  className?: string;
}

export function Badge({
  variant,
  size,
  tone,
  dot = false,
  children,
  className,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(badgeStyles({ variant, size, tone }), className)}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden="true"
          data-role="badge-dot"
          className="inline-block size-1.5 rounded-full bg-current"
        />
      ) : null}
      {children}
    </span>
  );
}
