/**
 * Shared review-gate implementation.
 *
 * Enforces the same transition rules across CLI, REST PATCH, and MCP update_task.
 * CLI and MCP enforce all five gates; PATCH (human/UI path) enforces only the
 * research gate — comment/commit/verify are handled by the UI separately.
 */
import type { ProtoSettings } from "./settings.js";
import { findTaskFilePath, readTaskFile } from "./tasks.js";
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
 * 4. VERIFY_REQUIRED — UI task must be verified before review
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
    skipVerify?: boolean;
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
      message:
        "--commit-message is required (auto-commit setting is ON)",
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

  // Gate 4: verify gate for UI tasks
  if (
    ctx.settings.requireVerifyBeforeReview &&
    !opts.skipVerify
  ) {
    const taskFilePath = findTaskFilePath(projectDir, taskId);
    const task = taskFilePath ? readTaskFile(taskFilePath) : null;
    if (task) {
      const hasSelector =
        task.cssSelector || (task.selector && task.selector !== "/");
      const hasUrl = !!task.url;
      const isUiTask = Boolean(hasSelector && hasUrl);

      if (isUiTask && !task.verified) {
        return {
          ok: false,
          code: "VERIFY_REQUIRED",
          message:
            "vibeflow verify is required before setting status to review",
          suggestion: `Run: vibeflow verify ${taskId}`,
        };
      }
    }
  }

  // Gate 5: research gate — type research needs a .md report
  const taskFilePath = findTaskFilePath(projectDir, taskId);
  const task = taskFilePath ? readTaskFile(taskFilePath) : null;
  if (task && (task.type ?? "").toLowerCase() === "research") {
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
