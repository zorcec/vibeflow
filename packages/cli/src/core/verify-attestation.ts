/**
 * Agent attestation for the `verified` tri-state flag.
 *
 * `verified` is written by the AGENT, never by `vibeflow verify`. That command
 * only proves the annotated element still resolves and that the page logged no
 * NEW console errors — it cannot tell whether the task was accomplished. So the
 * agent judges correctness and attests when it transitions the task:
 *
 *   true      — the agent verified, and the task IS implemented correctly
 *   false     — the agent verified, and the task is NOT implemented correctly
 *   undefined — nothing assessed yet (no attestation, or reset on claim)
 *
 * `true` and `false` are BOTH completed verdicts about the correctness of the
 * work — one positive, one negative. `false` never means "unfinished" or "the
 * page broke". `review-gate.ts` requires the positive attestation (carried on
 * the transition) before an annotated task may go to review.
 */

/** The attestation flags as they arrive from `tasks --edit`. */
export interface VerifyAttestationFlags {
  /** `--verified`: the agent verified and the task IS implemented correctly. */
  verified?: boolean;
  /** `--verify-failed`: the agent verified and the task is NOT correct. */
  verifyFailed?: boolean;
}

export type VerifyAttestationResolution =
  | { ok: true; value: boolean | undefined }
  | { ok: false; message: string };

/**
 * Map the flag pair onto the tri-state value. Neither flag resolves to
 * `undefined`, meaning "leave the stored value as it is"; the two flags
 * together are contradictory because they assert opposite verdicts.
 */
export function resolveVerifyAttestation(
  flags: VerifyAttestationFlags,
): VerifyAttestationResolution {
  if (flags.verified && flags.verifyFailed) {
    return {
      ok: false,
      message:
        "--verified says the task IS implemented correctly, --verify-failed says it is NOT — pass at most one.",
    };
  }
  if (flags.verified) return { ok: true, value: true };
  if (flags.verifyFailed) return { ok: true, value: false };
  return { ok: true, value: undefined };
}
