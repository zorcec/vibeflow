/**
 * Shared review-gate implementation.
 *
 * WHO CALLS IT: exactly two surfaces — the CLI (`tasks --edit --set-status
 * review`) and MCP `update_task`. Both enforce all five gates.
 *
 * The HTTP `PATCH /api/tasks/:id` route does NOT call this gate. It enforces
 * the research rule itself, inline (server.ts), and only that one: the UI is
 * the human path, so comment/commit/branch/verify are its business. A previous
 * version of this docstring claimed the gate was shared with PATCH "alike",
 * and the same claim was repeated in the README, the changeset and this file's
 * suggestion comments; the route has no import of this module, so the claim
 * described a sharing that does not exist. Routing PATCH through the gate is a
 * behaviour change and is deliberately not done here.
 *
 * Gate 4 is an ATTESTATION gate: it needs the agent's verdict carried by this
 * transition (CLI `--set-verify pass|cannot`, MCP `setVerify`), not a
 * `verified` value stored on the task — `vibeflow verify` never writes that
 * flag. The human/UI PATCH path therefore cannot satisfy it: PATCH neither
 * accepts a verdict field (mass-assignment whitelist) nor runs this gate.
 *
 * P1 shape (ticket 3d613068): the DECISION lives in the import-pure
 * `core/review-decision.ts` (callable with plain data — resolved task,
 * settings, attachment names). This module is the LOCAL compatibility
 * wrapper: it performs the two reads the pure decision needs (task record,
 * attachment names) and delegates. No gate wording lives here.
 */
import type { ProtoSettings } from "./settings.js";
import {
  findTaskFilePath,
  readTaskFile,
} from "./tasks.js";
import { listFiles } from "./files.js";
import {
  decideReviewTransition,
  type ReviewDecisionInput,
  type ReviewTransitionOpts,
} from "./review-decision.js";

export type { ReviewDecisionInput, ReviewTransitionOpts };
export {
  decideReviewTransition,
  RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL,
} from "./review-decision.js";
export type { ReviewGateResult } from "./review-decision.js";

export interface ReviewGateContext {
  projectDir: string;
  settings: ProtoSettings;
}

/**
 * Check whether a status transition to "review" is allowed.
 * Non-review transitions always return { ok: true }.
 *
 * Local wrapper: reads the task record and the attachment names, then
 * delegates to the pure `decideReviewTransition`. The wrapper and the pure
 * decision return an identical matrix for identical inputs
 * (`tests/unit/review-gate.test.ts` pins it).
 */
export function checkReviewTransition(
  projectDir: string,
  taskId: string,
  opts: ReviewTransitionOpts,
  ctx: ReviewGateContext,
): ReturnType<typeof decideReviewTransition> {
  // Read the task once — Gate 4 (verify) and Gate 5 (research report) both
  // need it. Missing/unreadable resolves to null, which the pure decision
  // treats exactly as this wrapper historically did (gates 4b/5 skip).
  const taskFilePath = findTaskFilePath(projectDir, taskId);
  const task = taskFilePath ? readTaskFile(taskFilePath) : null;
  const attachmentNames = listFiles(projectDir, taskId).map((f) => f.name);
  return decideReviewTransition({
    task,
    attachmentNames,
    settings: ctx.settings,
    opts,
    taskId,
  });
}
