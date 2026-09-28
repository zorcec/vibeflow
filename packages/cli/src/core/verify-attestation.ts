/**
 * Agent attestation for the `verified` tri-state flag.
 *
 * `verified` is written by the AGENT, never by `vibeflow verify`. That command
 * only proves the annotated element still resolves and that the page logged no
 * NEW console errors — it cannot tell whether the task was accomplished. So the
 * agent judges correctness and attests when it transitions the task, via the
 * single tri-state flag `--set-verify <verdict>`:
 *
 *   pass   → verified=true   — the task IS implemented correctly (green badge)
 *   fail   → verified=false  — the task is NOT implemented correctly (amber
 *                              badge; the review gate rejects it)
 *   cannot → verified=absent — cannot be assessed here; REQUIRES the
 *                              accompanying --verify-reason, which is recorded
 *                              in the task's activity (no badge)
 *   omitted → nothing assessed yet (no attestation, or reset on claim)
 *
 * `pass` and `fail` are BOTH completed verdicts about the correctness of the
 * work — one positive, one negative. `fail` never means "unfinished" or "the
 * page broke"; absence is the only not-assessed state. `review-gate.ts` Gate 4
 * requires a verdict that lets the task through (`pass`, or `cannot` with its
 * reason) before an annotated task may go to review.
 */

/** The attestation flags as they arrive from `tasks --edit`. */
export interface VerifyAttestationFlags {
  /** `--set-verify`: pass | fail | cannot. */
  setVerify?: "pass" | "fail" | "cannot";
  /**
   * `--verify-reason`: why the task cannot be verified. REQUIRED when
   * `setVerify` is "cannot"; it is meaningless for pass/fail and rejected
   * loudly if passed without the "cannot" verdict.
   */
  verifyReason?: string;
}

export type VerifyAttestationResolution =
  | {
      ok: true;
      value: boolean | undefined;
      clear: boolean;
      verdict?: "pass" | "fail" | "cannot";
      reason?: string;
    }
  // `suggestion` is part of the CONTRACT, not a per-caller nicety: this type
  // is the only place that knows WHY a flag combination is invalid and what
  // the valid one is, so a caller that has only `{code, message}` has nothing
  // to hand an agent and the refusal is unrecoverable by construction. It
  // used to be exactly that fieldless, and both callers dropped the recovery
  // text they had no place to put.
  | { ok: false; message: string; code: string; suggestion: string };

/**
 * Map the tri-state flag onto the stored value plus a `clear` flag. No flag
 * resolves to `{ value: undefined, clear: false }`, meaning "leave the stored
 * value as it is"; `cannot` resolves to `{ value: undefined, clear: true }`,
 * meaning "write absence (no badge)" — and is only valid with a reason.
 */
export function resolveVerifyAttestation(
  flags: VerifyAttestationFlags,
): VerifyAttestationResolution {
  if (flags.setVerify === "cannot") {
    const reason = flags.verifyReason?.trim() ?? "";
    if (!reason) {
      return {
        ok: false,
        // Same rule the review gate enforces as VERIFY_REASON_REQUIRED, so the
        // machine-readable code matches whichever surface refuses it.
        code: "VERIFY_REASON_REQUIRED",
        message:
          "--set-verify cannot requires --verify-reason <why> — say why the task cannot be verified here.",
        // Both surfaces read this string (CLI, MCP, PATCH), so it names the
        // MCP input and the CLI flag — see the shared-surface rule in
        // review-gate.ts.
        suggestion:
          'Say why it cannot be verified here — pass `verifyReason` alongside setVerify:"cannot" (MCP), or --verify-reason "<why>" with --set-verify cannot (CLI)',
      };
    }
    return {
      ok: true,
      value: undefined,
      clear: true,
      verdict: "cannot",
      reason,
    };
  }
  if (flags.verifyReason?.trim()) {
    return {
      ok: false,
      // No gate equivalent: this is a pure usage error in the flag combination.
      code: "E_USAGE",
      message:
        "--verify-reason is only valid with --set-verify cannot — pass the reason together with the 'cannot' verdict.",
      suggestion:
        'A reason belongs to a "cannot" verdict — pass setVerify:"cannot" together with `verifyReason` (MCP), or --set-verify cannot --verify-reason "<why>" (CLI)',
    };
  }
  if (flags.setVerify === "pass") {
    return { ok: true, value: true, clear: false, verdict: "pass" };
  }
  if (flags.setVerify === "fail") {
    return { ok: true, value: false, clear: false, verdict: "fail" };
  }
  return { ok: true, value: undefined, clear: false };
}