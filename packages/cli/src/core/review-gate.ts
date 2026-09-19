/**
 * Shared review-gate implementation.
 *
 * Enforces the same transition rules across CLI, REST PATCH, and MCP update_task.
 * CLI and MCP enforce all five gates; PATCH (human/UI path) enforces only the
 * research gate — comment/commit/verify are handled by the UI separately.
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

export interface ReviewGateContext {
  projectDir: string;
  settings: ProtoSettings;
}

export type ReviewGateResult =
  | { ok: true }
  | { ok: false; code: string; message: string; suggestion?: string };

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

  // Gate 1: comment required when setting review
  if (!opts.comment?.trim()) {
    return {
      ok: false,
      code: "REVIEW_COMMENT_REQUIRED",
      message: "Comment is required when setting status to review",
      suggestion:
        'Use --comment "what changed and why" when setting status to review',
    };
  }

  // Gate 2: commitMessage required when autoCommit is ON
  if (ctx.settings.autoCommit && !opts.commitMessage?.trim()) {
    return {
      ok: false,
      code: "COMMIT_MESSAGE_REQUIRED",
      message: "--commit-message is required (auto-commit setting is ON)",
      suggestion:
        'Stage your changes first, then provide a one-line commit summary with --commit-message "fix: description"',
    };
  }

  // Gate 3: branch required when createBranch is ON
  if (ctx.settings.createBranch && !opts.branch?.trim()) {
    return {
      ok: false,
      code: "BRANCH_REQUIRED",
      message: "--branch is required (create-branch setting is ON)",
      suggestion:
        "Provide the git branch name created for this task with --branch",
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
      return {
        ok: false,
        code: "RESEARCH_VERIFY_NOT_ALLOWED",
        message:
          "A Research task cannot carry a verification verdict — it has no annotated UI to verify",
        suggestion:
          "Drop --set-verify; submit the Research task with its .md report instead",
      };
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
          'Fix the implementation and attest again with --set-verify pass, or park it: --set-status in-progress --set-verify fail --comment "what is wrong"',
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
        suggestion:
          'Example: --set-verify cannot --verify-reason "no accessible environment to verify in"',
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
              'Fix the implementation, then attest with --set-verify pass; or park it: --set-status in-progress --set-verify fail --comment "what is wrong"',
          };
        }
        return {
          ok: false,
          code: "VERIFY_REQUIRED",
          message:
            "Annotated tasks need a verification verdict before review — attest how you verified the work",
          suggestion: `Pass one of: --set-verify pass (implemented correctly), --set-verify fail (NOT correct — blocks review), or --set-verify cannot --verify-reason "<why>" (unverifiable here). Example: run vibeflow verify ${taskId}, judge the evidence, then pass the verdict on the review transition`,
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
        suggestion:
          "Provide a research report with --report-file ./my-report.md",
      };
    }
  }

  return { ok: true };
}
