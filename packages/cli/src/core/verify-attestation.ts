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
 /**
  * `--unset-verified`: clear the verdict back to absent. This is NOT the same
  * as `--verify-failed`: `clear` means "cannot be assessed here", while
  * `verifyFailed` means "assessed and it is WRONG". An unverifiable task is
  * cleared so the UI shows no badge instead of a stale or false one.
  */
 unset?: boolean;
}

export type VerifyAttestationResolution =
 | { ok: true; value: boolean | undefined; clear: boolean }
 | { ok: false; message: string };

/**
 * Map the flag trio onto the tri-state value plus a `clear` flag. No flag
 * resolves to `{ value: undefined, clear: false }`, meaning "leave the stored
 * value as it is"; `--unset-verified` resolves to `{ value: undefined, clear:
 * true }`, meaning "write absence". The three flags are mutually exclusive
 * because each asserts a different verdict.
 */
export function resolveVerifyAttestation(
 flags: VerifyAttestationFlags,
): VerifyAttestationResolution {
 if (flags.unset && (flags.verified || flags.verifyFailed)) {
  return {
   ok: false,
   message:
    "--unset-verified clears the verdict to absent; it cannot be combined with --verified / --verify-failed.",
  };
 }
 if (flags.verified && flags.verifyFailed) {
  return {
   ok: false,
   message:
    "--verified says the task IS implemented correctly, --verify-failed says it is NOT — pass at most one.",
  };
 }
 if (flags.unset) return { ok: true, value: undefined, clear: true };
 if (flags.verified) return { ok: true, value: true, clear: false };
 if (flags.verifyFailed) return { ok: true, value: false, clear: false };
 return { ok: true, value: undefined, clear: false };
}
