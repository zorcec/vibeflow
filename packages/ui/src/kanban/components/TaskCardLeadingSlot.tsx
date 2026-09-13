import React from "react";
import { CheckCircle } from "lucide-react";
import { VerifyIndicator, type VerifyState } from "./VerifyIndicator";

/**
 * The leading slot at the head of a card's title row.
 *
 * Both TaskCard layouts draw this slot — the multi-row card for the board's open
 * lanes, and the single-row card used by the done lane and by the compact view.
 * Each layout used to build the slot inline and the two disagreed: the
 * single-row copy chose one glyph while the multi-row copy appended a loader, a
 * verify glyph and an unread dot, so a single card could carry three marks and
 * its title started further right than every other card in the lane. Layout now
 * passes the facts in; the choice of mark and the reserved width live here, once.
 *
 * The slot draws AT MOST ONE mark, by this precedence:
 *   1. verify verdict  — a completed assessment (review and done lanes only)
 *   2. in-flight work  — the loader, or the pulsing lane dot in the row layout
 *   3. done affordance — the done lane's neutral glyph
 *   4. unread dot      — a viewer-specific cue
 *   5. lane status dot — the row layout's neutral glyph
 * The verdict outranks the loader because the fact is permanent and the activity
 * is transient; the unread dot is the weakest cue and yields to every status
 * mark. Anything above the status dot is also what keeps the two layouts
 * agreeing: both read the same precedence, and only the *rendering* of a mark
 * differs between them (a loader in one, a pulsing dot in the other).
 *
 * The verdict itself is gated to the review and done lanes — see
 * `showsVerifyVerdict` in ./VerifyIndicator — so the `verify` this slot receives
 * is already "none" everywhere else; that is why no lane can pair a verdict with
 * a loader.
 */
export type LeadingSlotMark =
      | "verify"
      | "activity"
      | "done"
      | "unread"
      | "status";

/** Which card layout owns the slot. */
export type LeadingSlotLayout = "card" | "row";

/**
 * Optical sizes. `1c4374c` settled these and each matches the element it sits
 * beside on screen: the multi-row glyph matches the 11px `.spinner`, the
 * single-row glyph matches the 12px muted done check.
 */
const CARD_MARK_SIZE = 11;
const ROW_MARK_SIZE = 12;
/** `.spinner` in kanban.css. */
const ACTIVITY_SPINNER_SIZE = 11;

const MARK_BOX_STYLE: React.CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      flexShrink: 0,
};

/**
 * Width reserved for the slot: the widest mark the layout can draw. Reserving it
 * keeps the title's x-offset identical for every card in a lane, whatever mark
 * happens to render — the fix for the slot that grew to three marks and pushed
 * the title around.
 */
export function leadingSlotWidth(layout: LeadingSlotLayout): number {
      return layout === "card" ? CARD_MARK_SIZE : ROW_MARK_SIZE;
}

export interface LeadingSlotInput {
      /**
       * Verdict to draw, already gated to the lanes that show one by
       * `verifyState`. "none" leaves the slot to the status marks.
       */
      verify: VerifyState;
      layout: LeadingSlotLayout;
      /** The card sits in the in-progress lane. */
      isInProgress: boolean;
      /** The card sits in the done lane. */
      isDone: boolean;
      /** The viewer has not opened this task. */
      isUnread: boolean;
}

/** The single mark the slot draws, or nothing at all. */
export function resolveLeadingSlotMarks({
      verify,
      layout,
      isInProgress,
      isDone,
      isUnread,
}: LeadingSlotInput): LeadingSlotMark[] {
      if (verify !== "none") return ["verify"];
      if (isInProgress) return ["activity"];
      if (isDone) return ["done"];
      if (isUnread) return ["unread"];
      // The neutral lane dot belongs to the single-row layout alone: the
      // multi-row card colours its border with the lane colour instead.
      if (layout === "row") return ["status"];
      return [];
}

export interface LeadingSlotProps extends LeadingSlotInput {
      /** Lane id — names the row layout's neutral status dot. */
      columnId: string;
}

/**
 * Renders the leading mark inside a fixed-width box. `data-role="leading-slot"`
 * and `data-leading-mark` are what the layout tests bind to.
 */
export function LeadingSlot({
      verify,
      layout,
      isInProgress,
      isDone,
      isUnread,
      columnId,
}: LeadingSlotProps) {
      const marks = resolveLeadingSlotMarks({
            verify,
            layout,
            isInProgress,
            isDone,
            isUnread,
      });
      const width = leadingSlotWidth(layout);
      const size = layout === "card" ? CARD_MARK_SIZE : ROW_MARK_SIZE;
      return (
            <span
                  data-role="leading-slot"
                  data-marks={marks.length}
                  style={{
                        ...MARK_BOX_STYLE,
                        justifyContent: "flex-start",
                        width,
                        minWidth: width,
                  }}
            >
                  {marks.map((mark) => (
                        <span
                              key={mark}
                              data-leading-mark={mark}
                              style={MARK_BOX_STYLE}
                        >
                              {renderMark(mark, {
                                    verify,
                                    size,
                                    layout,
                                    columnId,
                              })}
                        </span>
                  ))}
            </span>
      );
}

function renderMark(
      mark: LeadingSlotMark,
      {
            verify,
            size,
            layout,
            columnId,
      }: {
            verify: VerifyState;
            size: number;
            layout: LeadingSlotLayout;
            columnId: string;
      },
): React.ReactNode {
      switch (mark) {
            case "verify":
                  return <VerifyIndicator state={verify} size={size} />;
            case "activity":
                  // The row layout already expresses in-flight work with the
                  // pulsing lane dot; the multi-row card uses the spinner.
                  return layout === "row" ? (
                        laneDot(columnId)
                  ) : (
                        <span
                              className="spinner"
                              style={{
                                    width: ACTIVITY_SPINNER_SIZE,
                                    height: ACTIVITY_SPINNER_SIZE,
                                    flexShrink: 0,
                              }}
                        />
                  );
            case "done":
                  return (
                        <CheckCircle
                              style={{
                                    width: size,
                                    height: size,
                                    color: "color-mix(in srgb, var(--t-success) 55%, transparent)",
                                    flexShrink: 0,
                              }}
                        />
                  );
            case "unread":
                  return (
                        <span
                              title="Unread"
                              style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: "50%",
                                    background: "var(--t-accent-contrast)",
                                    flexShrink: 0,
                              }}
                        />
                  );
            case "status":
                  return laneDot(columnId);
      }
}

function laneDot(columnId: string): React.ReactNode {
      return <span className={`sd-${columnId}`} style={{ flexShrink: 0 }} />;
}
