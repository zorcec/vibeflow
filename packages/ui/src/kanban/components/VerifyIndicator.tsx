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

/** Whether a lane id (or a child's own status) renders a verify verdict. */
export function showsVerifyVerdict(columnId: string | undefined): boolean {
  return columnId !== undefined && VERDICT_LANES.includes(columnId);
}

export function verifyState(task: { verified?: boolean }): VerifyState {
  if (task.verified === true) return "verified";
  if (task.verified === false) return "failed";
  return "none";
}

/**
 * The verdict a surface should DRAW for a task: its tri-state verdict, or
 * "none" in the lanes that do not show one. Every surface reads the verdict
 * through this function, so the review/done gate lives in exactly one place and
 * cannot drift between the card layouts and the child rows.
 */
export function displayedVerifyState(task: {
  verified?: boolean;
  status?: TaskStatus;
}): VerifyState {
  return showsVerifyVerdict(task.status) ? verifyState(task) : "none";
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
