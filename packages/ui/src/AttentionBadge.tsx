import React from "react";
import { Bell } from "lucide-react";

/**
 * Needs-attention indicator (ticket 0752d55c): an amber bell glyph in the
 * VerifyIndicator treatment — the agent flagged the task and the reason
 * lives in the activity feed. Shape (bell) carries the meaning;
 * `title`/`aria-label` carry the words, so the state never relies on
 * colour alone.
 *
 * Icon choice (owner order, pill → indicator restyle): Bell, NOT AlertCircle.
 * AlertCircle is already the failed-verification glyph, and reusing it here
 * would conflate "the agent flagged this for attention" with "the work is
 * NOT implemented correctly". The bell silhouette is visually distinct from
 * both verify glyphs (CheckCircle / AlertCircle) while reading as the same
 * indicator family: same optical sizes (11 card + detail header, 10 tree
 * row), same leading-slot adjacency, same role/title/aria contract.
 *
 * Renders nothing when the task is not flagged, so callers can place it
 * unconditionally next to the leading status/verify slot.
 */
interface Props {
      flagged?: boolean;
      /** Optical size in px — match the neighbouring slot glyph (11 card, 10 tree row). */
      size?: number;
      style?: React.CSSProperties;
      /**
       * Jump-to-reason handler (round 2): when provided the bell renders
       * as a native button that jumps straight to the reason — card and
       * child-row bells open the detail panel on the activity/comments tab,
       * the detail-header bell switches to it. The inner glyph keeps its
       * role/title/aria contract, so the non-interactive rendering stays
       * byte-identical and existing selectors keep resolving.
       */
      onPress?: (e: React.MouseEvent) => void;
}

export function AttentionBadge({ flagged, size = 11, style, onPress }: Props) {
      if (flagged !== true) return null;
      const glyph = (
            <span
                  className="attention-indicator"
                  data-attention-state="flagged"
                  role="img"
                  aria-label="Needs attention"
                  title="Needs attention — the agent flagged this task; the reason is in the activity feed"
                  style={{
                        display: "inline-flex",
                        flexShrink: 0,
                        color: "var(--t-chip-amber-300)",
                        ...style,
                  }}
            >
                  <Bell aria-hidden="true" style={{ width: size, height: size }} />
            </span>
      );
      if (!onPress) return glyph;
      return (
            <button
                  type="button"
                  data-attention-press="true"
                  aria-label="Needs attention — open the activity feed"
                  title="Needs attention — open the activity feed"
                  onClick={onPress}
                  style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        // Slightly larger hit area without shifting layout.
                        padding: 2,
                        margin: -2,
                        background: "transparent",
                        border: "none",
                        borderRadius: "50%",
                        cursor: "pointer",
                        color: "inherit",
                  }}
            >
                  {glyph}
            </button>
      );
}
