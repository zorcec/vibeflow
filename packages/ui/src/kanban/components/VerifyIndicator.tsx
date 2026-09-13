import React from "react";
import { AlertCircle, CheckCircle } from "lucide-react";

/**
 * Three-state verify result, derived from the task's tri-state `verified` flag:
 *   true      → the last `vibeflow verify` passed
 *   false     → the last `vibeflow verify` FAILED
 *   undefined → verify has never run (or was reset when the task was claimed)
 *
 * `false` and `undefined` are deliberately distinct: `false` is a completed
 * negative fact, `undefined` is the absence of any verdict. Read the flag with
 * `=== true` / `=== false` — truthiness collapses the two.
 */
export type VerifyState = "verified" | "failed" | "none";

export function verifyState(task: { verified?: boolean }): VerifyState {
  if (task.verified === true) return "verified";
  if (task.verified === false) return "failed";
  return "none";
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
  const label = verified ? "Verified" : "Verification failed";
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
