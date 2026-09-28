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
 */
import type { ProtoSettings } from "./settings.js";
import {
  findTaskFilePath,
  isResearchType,
  readTaskFile,
} from "./tasks.js";
import { listFiles } from "./files.js";
import { VERIFY_REASON_REQUIRED_SUGGESTION } from "./verify-attestation.js";

export interface ReviewGateContext {
  projectDir: string;
  settings: ProtoSettings;
}

export type ReviewGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string; suggestion?: string };

/**
 * The ONE wording of the `RESEARCH_VERIFY_NOT_ALLOWED` refusal.
 *
 * The rule has three producers: this gate, the CLI's standalone
 * `--set-verify` check in index.ts (which refuses a Research verdict that
 * never reaches a review transition), and — through the CLI — the human
 * printer. All three used to carry the same sentence copied out longhand, so
 * an edit to one left the others stale and a client could get two different
 * answers to the same question. Exported so all three read one definition.
 */
export const RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL = {
  code: "RESEARCH_VERIFY_NOT_ALLOWED",
  message:
    "A Research task cannot carry a verification verdict — it has no annotated UI to verify",
  suggestion:
    "Drop the verdict — setVerify (MCP) or --set-verify (CLI) — and submit the Research task with its .md report attached via attach_file (MCP) or --report-file (CLI) instead",
} as const;

/**
 * Check whether a status transition to "review" is allowed.
 * Non-review transitions always return { ok: true }.
 *
 * Gates enforced:
 * 1. REVIEW_COMMENT_REQUIRED — comment is mandatory on review
 * 2. COMMIT_MESSAGE_REQUIRED — commitMessage when autoCommit is ON
 * 3. BRANCH_REQUIRED — branch when createBranch is ON
 * 4. VERIFY_REQUIRED / VERIFY_FAILED_ATTESTED / VERIFY_REASON_REQUIRED —
 *    annotated tasks need the agent's verdict on this transition (pass, fail,
 *    cannot); a `fail` verdict can never reach review, and `cannot` must carry
 *    a reason
 * 5. RESEARCH_REPORT_REQUIRED — Research tasks need a .md report
 */
export function checkReviewTransition(
  projectDir: string,
  taskId: string,
  opts: {
    comment?: string;
    commitMessage?: string;
    branch?: string;
    reportFile?: string;
    /**
     * The verification verdict carried by THIS transition:
     *  - "pass"   = the task IS implemented correctly (verified=true, green badge)
     *  - "fail"   = the task is NOT implemented correctly (verified=false, amber
     *               badge — never reaches review)
     *  - "cannot" = cannot be assessed here (verified=absent, no badge — requires
     *               verifyReason)
     *  - undefined = no verdict given on this transition
     */
    verifyVerdict?: "pass" | "fail" | "cannot";
    /**
     * Reason for a "cannot" verdict. REQUIRED whenever verifyVerdict is
     * "cannot", and recorded in the task's activity so the detail panel shows
     * why the task carries no verdict.
     */
    verifyReason?: string;
  },
  ctx: ReviewGateContext,
): ReviewGateResult {
  if (!opts.commitMessage) {
    opts.commitMessage = undefined;
  }

  // Only enforce gates on review transitions
  if (!taskId) return { ok: true };

  // Gate 1: comment required when setting review.
  // The suggestion carries the full implementation-report guidance — it is
  // shared by the CLI and MCP update_task, and it used to exist only in the
  // CLI's (since deleted) duplicate pre-check.
  //
  // SHARED-SURFACE RULE (the RESEARCH_REPORT_REQUIRED pattern, ticket
  // ef2a7585): this string is read by two surfaces, so it must name the route
  // on EACH of them. The CLI flag alone was an answer an MCP client could not
  // act on — it has no flags at all. One line: what to write, then where to
  // write it, per surface.
  if (!opts.comment?.trim()) {
    return {
      ok: false,
      code: "REVIEW_COMMENT_REQUIRED",
      message: "Comment is required when setting status to review",
      suggestion:
        "Provide a concise implementation report explaining: what was changed and why · key decisions and trade-offs · anything future agents should know — pass it as `comment` on update_task (MCP) or --comment \"what changed and why\" (CLI)",
    };
  }

  // Gate 2: commitMessage required when autoCommit is ON
  if (ctx.settings.autoCommit && !opts.commitMessage?.trim()) {
    return {
      ok: false,
      code: "COMMIT_MESSAGE_REQUIRED",
      message: "--commit-message is required (auto-commit setting is ON)",
      suggestion:
        'Stage your changes first, then give a one-line commit summary — pass `commitMessage` on update_task (MCP) or --commit-message "fix: description" (CLI)',
    };
  }

  // Gate 3: branch required when createBranch is ON
  if (ctx.settings.createBranch && !opts.branch?.trim()) {
    return {
      ok: false,
      code: "BRANCH_REQUIRED",
      message: "--branch is required (create-branch setting is ON)",
      suggestion:
        "Name the git branch created for this task — pass `branch` on update_task (MCP) or --branch (CLI)",
    };
  }

  // Read the task once — Gate 4 (verify) and Gate 5 (research report) both need it.
  const taskFilePath = findTaskFilePath(projectDir, taskId);
  const task = taskFilePath ? readTaskFile(taskFilePath) : null;

  // Gate 4: the verify verdict. Research tasks are EXEMPT entirely — they
  // have no annotated UI element to verify (their deliverable is a report), so
  // demanding a verdict is unsatisfiable. This is the fix for the
  // reproduced case where a Research task carrying url + selector '#main'
  // (9f6e1ac7) had its review transition refused until a bypass flag.
  //
  // A verdict on a Research task is meaningless under the tri-state semantics
  // (a stored `false` would read as "verified as NOT implemented correctly", an
  // active lie), so a verdict passed on this transition is refused LOUDLY
  // rather than dropped silently — this CLI already has too many silent no-ops.
  if (isResearchType(task?.type)) {
    if (opts.verifyVerdict !== undefined) {
      // One definition, shared with the CLI's standalone `--set-verify` path —
      // see RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL above.
      return { ok: false, ...RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL };
    }
  } else {
    // Gate 4a: a "fail" verdict can never reach review — for ANY task, and
    // even on a non-annotated one: it is the agent's own "this is NOT correct"
    // verdict and no gate setting can overrule the agent's assessment.
    if (opts.verifyVerdict === "fail") {
      return {
        ok: false,
        code: "VERIFY_FAILED_ATTESTED",
        message:
          "You attested that this task is NOT implemented correctly — it cannot go to review",
        suggestion:
          'Fix the implementation, then attest again with setVerify:"pass" (MCP) or --set-verify pass (CLI) — or park it: in-progress with setVerify:"fail" (MCP) / --set-verify fail (CLI) and a comment saying what is wrong',
      };
    }

    // Rule (unconditional): "cannot" REQUIRES --verify-reason. The reason is
    // what makes the absence honest — it is recorded in the task's activity so
    // reviewers can see why no verdict (and no badge) exists.
    if (opts.verifyVerdict === "cannot" && !opts.verifyReason?.trim()) {
      return {
        ok: false,
        code: "VERIFY_REASON_REQUIRED",
        message:
          "--set-verify cannot requires --verify-reason — say why the task cannot be verified",
        // The SAME text resolveVerifyAttestation returns for this code (a
        // standalone `setVerify:"cannot"` on a task that is not under review):
        // one code, one recovery, whichever producer refuses.
        suggestion: VERIFY_REASON_REQUIRED_SUGGESTION,
      };
    }

    // Gate 4b: the verify ATTESTATION.
    //
    // The agent writes the verdict, not `vibeflow verify` (verify only proves
    // the annotated element resolves and that no NEW console errors appeared; it
    // cannot tell whether the task was accomplished). So this gate demands the
    // verdict carried BY THIS TRANSITION, never a value left in the store: a
    // stored `true` may be stale, and a stored `false` is the agent's verdict
    // that the work is WRONG.
    if (ctx.settings.requireVerifyBeforeReview) {
      // Scope: annotated tasks (selector + URL). `vibeflow verify` needs an
      // annotation baseline, so a task without one can never be asked to
      // produce its evidence. The gate deliberately does NOT depend on that
      // baseline existing — its absence used to skip the gate silently.
      const hasSelector =
        task?.cssSelector || (task?.selector && task.selector !== "/");
      const isAnnotated = Boolean(hasSelector && task?.url);

      if (
        isAnnotated &&
        opts.verifyVerdict !== "pass" &&
        opts.verifyVerdict !== "cannot"
      ) {
        if (task?.verified === false) {
          return {
            ok: false,
            code: "VERIFY_FAILED_ATTESTED",
            message:
              "This task carries your verdict that it is NOT implemented correctly — it cannot go to review",
            suggestion:
              'Fix the implementation, then attest with setVerify:"pass" (MCP) or --set-verify pass (CLI); or park it: in-progress with setVerify:"fail" (MCP) / --set-verify fail (CLI) and a comment saying what is wrong',
          };
        }
        return {
          ok: false,
          code: "VERIFY_REQUIRED",
          message:
            "Annotated tasks need a verification verdict before review — attest how you verified the work",
          // ONE compact statement per surface, each naming all three verdicts.
          // This used to state the three twice per surface inside a single
          // "Pass one of: …" sentence that ran ~440 characters, which no one
          // reads to the end.
          suggestion: `MCP: setVerify:"pass" (implemented correctly) · setVerify:"fail" (NOT correct — blocks review) · setVerify:"cannot" with verifyReason (unverifiable here) — CLI: the same three are --set-verify pass · --set-verify fail · --set-verify cannot --verify-reason "<why>". Collect the evidence with vibeflow verify ${taskId}, judge it, then attest on this transition`,
        };
      }
    }
  }

  // Gate 5: research gate — type research needs a .md report
  if (task && isResearchType(task.type)) {
    const attachedFiles = listFiles(projectDir, taskId);
    const hasMdFile = attachedFiles.some((f) => /\.md$/i.test(f.name));
    if (!hasMdFile) {
      return {
        ok: false,
        code: "RESEARCH_REPORT_REQUIRED",
        message:
          "Cannot mark Research task as review: no .md report file attached",
        // Both surfaces reach this gate, so the suggestion names both routes:
        // --report-file is CLI-only, and an MCP client has no such flag — its
        // recovery is attach_file with a .md filename.
        suggestion:
          "Provide a research report: attach a .md file with attach_file (MCP) or pass --report-file ./my-report.md (CLI)",
      };
    }
  }

  return { ok: true };
}
