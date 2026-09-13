import React from "react";
import { CheckCircle } from "lucide-react";
import type { Task } from "../types";
import {
     VerifyIndicator,
     displayedVerifyState,
     type VerifyState,
} from "./VerifyIndicator";

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
 * The verdict itself is gated to the review and done lanes AND to the types that
 * can be verified — see `showsVerifyVerdict` in ./VerifyIndicator — so the
 * `verify` this slot receives is already "none" for every other lane and type;
 * that is why no lane can pair a verdict with a loader.
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
 * Width reserved for the slot: the widest mark the layout can draw.
 * Reserving it keeps the title's x-offset identical for every card in a lane,
 * whatever mark happens to render — the fix for the slot that grew to three
 * marks and pushed the title around (b0545910).
 *
 * Only a lane that actually draws at least one mark may reserve it — see
 * `laneReservesLeadingSlot`. A lane where no card resolves a mark has nothing to
 * align to, so it reserves nothing and the title sits flush (8545aeca).
 */
export function leadingSlotWidth(layout: LeadingSlotLayout): number {
     return layout === "card" ? CARD_MARK_SIZE : ROW_MARK_SIZE;
}

/** The lane facts `laneReservesLeadingSlot` needs to resolve a card's marks. */
export interface LeadingSlotLane {
     /** The lane id the cards sit in (a task status). */
     laneId: string;
     /** The card layout this lane renders — the compact view uses the row layout. */
     compact?: boolean;
     currentUserId?: string;
}

/**
 * Whether a lane must reserve the leading slot's width.
 *
 * The reservation exists only to keep titles aligned between cards of the SAME
 * lane (b0545910), so it is needed only when the lane draws at least one mark. In
 * a lane where every card resolves no mark — every card read, none verified, none
 * in-flight — reserving would leave an empty gutter before every title, which is
 * the phantom gap of 8545aeca.
 *
 * Call this ONCE per lane and pass the result down; asking each card to scan its
 * siblings would be O(n²). It reuses `resolveLeadingSlotMarks`, so the lane's
 * answer and the card's own marks cannot drift.
 */
export function laneReservesLeadingSlot(
     tasks: readonly Task[],
     { laneId, compact, currentUserId }: LeadingSlotLane,
): boolean {
     const layout = layoutForLane(laneId, compact);
     const isInProgress = laneId === "in-progress";
     const isDone = laneId === "done";
     return tasks.some(
          (task) =>
               resolveLeadingSlotMarks({
                    verify: displayedVerifyState(task),
                    layout,
                    isInProgress,
                    isDone,
                    isUnread:
                         !!currentUserId &&
                         !(task.openedBy ?? []).includes(currentUserId),
               }).length > 0,
     );
}

/** The layout a lane renders in: the done lane and the compact view use one row. */
function layoutForLane(
     laneId: string,
     compact: boolean | undefined,
): LeadingSlotLayout {
     return compact || laneId === "done" ? "row" : "card";
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
     /**
      * Whether this card's lane reserves the slot's width — the lane-level
      * answer from `laneReservesLeadingSlot`. Defaults to reserving, so a caller
      * that does not know its lane keeps the b0545910 alignment guarantee.
      */
     reserve?: boolean;
}

/**
 * Renders the leading mark for a card's title row. `data-role="leading-slot"`
 * and `data-leading-mark` are what the layout tests bind to.
 *
 * A card that resolves NO mark renders NOTHING — no box, and no reserved space.
 *
 * The history here is worth keeping, because two earlier attempts each fixed half
 * of it:
 *
 *   - b0545910 wanted every title in a lane at the same x-offset, and got it by
 *     painting the slot on every card. A markless card therefore carried an empty
 *     11px box — visually a badge that had failed to load. That is the phantom
 *     space of 8545aeca.
 *   - 8545aeca then reserved the width with an invisible spacer instead. That hid
 *     the fake badge but kept the gap, which is still wrong: the owner asked for
 *     the space to be REMOVED, not made neutral.
 *
 * The alignment goal and the reserved-gap goal turned out to be in conflict, and
 * alignment lost: titles in a lane with mixed marks no longer share one x-offset.
 * That is the owner's explicit choice (option B, Sep 2026) — a visible empty gap
 * before a title reads as a broken badge, and that is worse than a ragged left
 * edge. So `reserve` no longer has any effect on rendering; it is retained only
 * so existing callers do not break.
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
     if (marks.length === 0) return null;
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
