import React from "react";
import { AlertCircle, CheckCircle } from "lucide-react";
import type { TaskStatus } from "../types";

/**
 * Three-state verify result, derived from the task's tri-state `verified` flag:
 *   true      → the agent verified, and the work IS implemented correctly
 *   false     → the agent verified, and the work is NOT implemented correctly
 *   undefined → nothing done yet (no verdict, or it was reset when claimed)
 *
 * `true` and `false` are BOTH completed verdicts about the correctness of the
 * work — one positive, one negative. `false` never means "unfinished" or "the
 * page broke"; `undefined` is the only not-assessed state. Read the flag with
 * `=== true` / `=== false` — truthiness collapses the two.
 */
export type VerifyState = "verified" | "failed" | "none";

/**
 * Lanes that show a verify verdict. A verdict assesses work that is being
 * reviewed or is finished, so only the review and done lanes render it;
 * backlog / todo / in-progress keep their plain status glyphs (owner decision
 * on 366e64dc). Child rows follow the same rule, judged by the child's own
 * status.
 */
export const VERDICT_LANES: readonly string[] = ["review", "done"];

/**
 * Task types that can never carry a UI verify verdict (bb308ad4).
 *
 * `vibeflow verify` needs an annotation baseline (selector + URL) to collect
 * evidence, and the CLI forbids Research tasks from producing code at all — they
 * deliver a findings report. So a stored `verified` value on a Research task
 * attests to a UI change that was never made: the amber badge is a lie. Nothing
 * else is excluded — see `showsVerifyVerdict`.
 */
export const UNVERIFIABLE_TASK_TYPES: readonly string[] = ["Research"];

/**
 * THE gate for the verify verdict — the one place the policy lives. A verdict is
 * drawn only when BOTH hold:
 *
 * 1. the lane is review/done (a verdict assesses reviewed/finished work), and
 * 2. the task's type can be verified at all — see `UNVERIFIABLE_TASK_TYPES`.
 *
 * The gate reads the TYPE, never whether a value happens to be stored: a
 * Research task with `verified: true` is just as absent from the board as one
 * with `false`.
 *
 * Types the store carries but the board does not model — Enhancement, Feature,
 * Chore, and the 239 tasks with no type at all — all SHOW. They resolve to the
 * generic Task everywhere else (`TypeBadge`, `getTaskTypeIcon(type ?? "Task")`,
 * CLI `normalizeTaskType` maps every non-{Task,Bug,Research} value to the
 * generic Task), and the owner's rule names Task, so an untyped card counts as a
 * Task and keeps whatever verdict it carries. Only Research is excluded. To
 * change the policy, change `UNVERIFIABLE_TASK_TYPES` — nothing else reads a
 * task type.
 */
export function showsVerifyVerdict(task: {
 status?: TaskStatus;
 type?: unknown;
}): boolean {
 if (task.status === undefined || !VERDICT_LANES.includes(task.status))
  return false;
 return !isUnverifiableType(task.type);
}

function isUnverifiableType(type: unknown): boolean {
 if (typeof type !== "string") return false;
 const normalized = type.trim().toLowerCase();
 return UNVERIFIABLE_TASK_TYPES.some(
  (candidate) => candidate.toLowerCase() === normalized,
 );
}

export function verifyState(task: { verified?: boolean }): VerifyState {
 if (task.verified === true) return "verified";
 if (task.verified === false) return "failed";
 return "none";
}

/**
 * The verdict a surface should DRAW for a task: its tri-state verdict, or
 * "none" in the lanes or task types that do not show one. Every surface reads
 * the verdict through this function, so the lane gate and the type gate live in
 * exactly one place and cannot drift between the card layouts, the leading slot
 * and the child rows.
 */
export function displayedVerifyState(task: {
 verified?: boolean;
 status?: TaskStatus;
 type?: unknown;
}): VerifyState {
 return showsVerifyVerdict(task) ? verifyState(task) : "none";
}

interface VerifyIndicatorProps {
 state: VerifyState;
 /** Optical size in px — match the neighbouring slot glyph (11 card, 10 tree row). */
 size?: number;
}

/**
 * The verify glyph for the leading icon slot. Renders nothing when the task
 * has no verdict, so the caller can fall back to its own status glyph.
 * Shape (check vs alert) carries the meaning; `title`/`aria-label` name it, so
 * the state never relies on colour alone.
 */
export function VerifyIndicator({ state, size = 11 }: VerifyIndicatorProps) {
 if (state === "none") return null;
 const verified = state === "verified";
 const Icon = verified ? CheckCircle : AlertCircle;
 const label = verified
  ? "Verified — implemented correctly"
  : "Failed verification — not implemented correctly";
 return (
  <span
   className={`verify-indicator verify-indicator--${state}`}
   data-verify-state={state}
   role="img"
   aria-label={label}
   title={label}
   style={{
    display: "inline-flex",
    flexShrink: 0,
    color: verified ? "var(--t-success)" : "var(--t-warning)",
   }}
  >
   <Icon aria-hidden="true" style={{ width: size, height: size }} />
  </span>
 );
}
