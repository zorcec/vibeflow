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
  | { ok: false; message: string };

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
        message:
          "--set-verify cannot requires --verify-reason <why> — say why the task cannot be verified here.",
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
      message:
        "--verify-reason is only valid with --set-verify cannot — pass the reason together with the 'cannot' verdict.",
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