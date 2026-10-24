/**
 * Explicit pathspec commit operation (ticket 4a5f7df6, P5).
 *
 * The shared implementation behind `vibeflow tasks --commit --task <id>
 * [--message "<msg>"] [-- <paths...>]`. There is deliberately NO MCP tool
 * (registry mapping `missing`): git commits stay a deliberate human CLI
 * action, never a remotely triggered write. The operation is still
 * shared-layer code so the pathspec scoping, the never-dead-end HEAD link,
 * and the best-effort auto-push live in one place with the same
 * characterization discipline as the other P5 extractions.
 *
 * Contract (mirrors the inline branch this replaces, byte-for-byte on every
 * pinned envelope):
 * - resolution through the ONE shared rule (`resolveTaskOrRefusal`, the
 *   same resolver edit/get use): exact id wins, unique prefix resolves,
 *   ambiguous names titled candidates (saas mode reads the board, local
 *   mode the local files). Refusals carry TASK_NOT_FOUND / E_AMBIGUOUS
 *   with the CLI's exact wording;
 * - `--dry-run` previews the tagged message and writes nothing (no commit,
 *   no record link, no push);
 * - with explicit paths, exactly those paths are committed (git's own
 *   pathspec records working-tree content); with no pathspec the scope is
 *   the task's own record and every other staged path is left in the index
 *   for its owner (reported as `foreign` / `leftStaged`);
 * - a clean tree links the existing HEAD instead of failing
 *   (`linkedExisting`, `sha` is HEAD) — committing is never a dead end;
 * - a failed commit is GIT_COMMIT_FAILED (the task record is untouched);
 * - auto-push is best-effort and still RUNS under `--json`: only the human
 *   progress lines are suppressed (via `capturePushOutput`), never the push
 *   itself — a failure rides the payload, because printing it would be
 *   trailing garbage behind the one JSON document. A linked HEAD created no
 *   new commit, so there is nothing to push (`attempted: false`).
 * - the git effect and the record link always target the project directory,
 *   never the board (there is no board commit to route through); only the
 *   id resolution follows the mode (board in saas, files in local).
 *
 * The human blocks (research warning, foreign-staged notice, linked/committed
 * sentences, push progress) travel on the returned data — the renderer below
 * performs no store or git reads of its own.
 */
import { execFileSync, execSync } from "node:child_process";
import type { OperationContext } from "../operations.js";
import { isDryRun } from "../operations.js";
import { resolveTaskOrRefusal } from "./resolution.js";
import { isRemoteReadError } from "../remote-task-store.js";
import { formatCommitTag } from "../commit-tag.js";

export interface CommitTaskPathsInput {
  /** Raw task selector, exactly as `--task` carried it. */
  id: string;
  /** `--message`; the task title when absent or blank. */
  message?: string;
  /** Explicit pathspec (everything after `--`); empty scopes to the task record. */
  paths?: string[];
  dryRun?: boolean;
  /**
   * True under `--json`: git's push chatter is captured into the payload
   * instead of inherited onto stdout (human mode keeps inheriting —
   * watching the push is the point of it).
   */
  capturePushOutput?: boolean;
}

export interface CommitAutoPushReport {
  attempted: boolean;
  ok: boolean;
  error?: string;
}

interface CommitTaskPathsPreview {
  dryRun: true;
  taskId: string;
  taskTitle: string;
  taskType?: string;
  /** Full message with the [vibeflow:id] tag — what a live run would commit. */
  message: string;
}

interface CommitTaskPathsDone {
  dryRun: false;
  taskId: string;
  taskTitle: string;
  taskType?: string;
  message: string;
  sha: string;
  linkedExisting: boolean;
  committed: string[];
  /**
   * Staged paths outside this task's scope, left in the index for their own
   * owner (populated only for the no-pathspec scope).
   */
  foreign: string[];
  autoPush: CommitAutoPushReport;
}

export type CommitTaskPathsData =
  | CommitTaskPathsPreview
  | CommitTaskPathsDone;

/**
 * The operation error, carrying the throw-path detail beside the envelope.
 * A failed commit (`!ok` from the git service) and a thrown commit share
 * the code `GIT_COMMIT_FAILED` but render differently in human mode: only
 * the throw path prints the `reason:` line, so the detail travels here
 * instead of overloading `suggestion` (which the notice path also sets).
 */
export interface CommitTaskPathsError {
  code: string;
  message: string;
  suggestion?: string;
  retryable?: boolean;
  reason?: string;
}

export type CommitTaskPathsResult =
  | { ok: true; data: CommitTaskPathsData; steps?: never; error?: never }
  | { ok: false; data?: never; steps?: never; error: CommitTaskPathsError };

/**
 * Pushes, and reports how it went.
 *
 * Moved here from `src/index.ts` (the explicit-commit branch owned the
 * original) so the operation layer owns the push effect and the sibling
 * post-review auto-commit path shares the one implementation. Semantics
 * unchanged: `git push`, falling back to `git push --set-upstream origin`
 * on the current branch; `captureOutput` keeps git's chatter out of the
 * `--json` document (a captured run folds git's own reason into the
 * returned error string).
 */
export function tryAutoPush(
  projectDir: string,
  opts: { captureOutput?: boolean } = {},
): { ok: boolean; error?: string } {
  const stdio: "inherit" | ["ignore", "pipe", "pipe"] = opts.captureOutput
    ? ["ignore", "pipe", "pipe"]
    : "inherit";
  try {
    execFileSync("git", ["push"], { cwd: projectDir, stdio });
    return { ok: true };
  } catch {
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: projectDir,
      })
        .toString()
        .trim();
      execFileSync("git", ["push", "--set-upstream", "origin", branch], {
        cwd: projectDir,
        stdio,
      });
      return { ok: true };
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      // A captured run has no console output to read, so git's own reason is
      // folded into the message — that string is what rides the JSON payload.
      const stderr =
        opts.captureOutput &&
        typeof (err2 as { stderr?: unknown }).stderr === "string"
          ? (err2 as { stderr: string }).stderr.trim()
          : "";
      return {
        ok: false,
        error: `${msg}${stderr ? `: ${stderr}` : ""}`.slice(0, 220),
      };
    }
  }
}

export async function commitTaskPathsOperation(
  ctx: OperationContext,
  input: CommitTaskPathsInput,
): Promise<CommitTaskPathsResult> {
  const rawId = input.id;
  // Resolution runs through the ONE shared rule (ticket e47d3004): the
  // same `resolveTaskOrRefusal` every other id-taking flag uses — exact id
  // wins, a UNIQUE prefix resolves, an ambiguous prefix is E_AMBIGUOUS
  // naming the candidates, an unknown id is TASK_NOT_FOUND. In saas mode
  // that reads the board (detail-first, then one listing for prefixes),
  // in local mode the local files. The git effect and the record link
  // below stay local: they scope a pathspec in THIS working tree and
  // link the record on disk — there is no board commit to route through.
  let resolvedId: string;
  let resolvedTitle: string;
  let resolvedType: string | undefined;
  try {
    const resolved = await resolveTaskOrRefusal(ctx, rawId);
    if (!resolved.ok) {
      return { ok: false, error: { ...resolved.error } };
    }
    resolvedId = resolved.id;
    resolvedTitle = resolved.task.title;
    resolvedType =
      typeof resolved.task.type === "string" ? resolved.task.type : undefined;
  } catch (err) {
    // A remote refusal travels verbatim (same rule as the read ops): the
    // code names the actual failure — E_AMBIGUOUS, auth, scope, transport.
    if (isRemoteReadError(err)) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.suggestion ? { suggestion: err.suggestion } : {}),
        },
      };
    }
    throw err;
  }
  const baseMsg = input.message?.trim() || resolvedTitle;
  const commitMsg = `${baseMsg} ${formatCommitTag(resolvedId)}`;

  if (isDryRun(ctx, input)) {
    return {
      ok: true,
      data: {
        dryRun: true,
        taskId: resolvedId,
        taskTitle: resolvedTitle,
        ...(resolvedType !== undefined ? { taskType: resolvedType } : {}),
        message: commitMsg,
      },
    };
  }

  const { commitTaskPaths } = await import("../git.js");
  let result: Awaited<ReturnType<typeof commitTaskPaths>>;
  try {
    result = commitTaskPaths(
      ctx.projectDir,
      resolvedId,
      baseMsg,
      input.paths ?? [],
    );
  } catch (err) {
    // Nothing was written on this path either, so the refusal is truthful:
    // no commit record, no task-file change. The code is the SAME
    // `GIT_COMMIT_FAILED` the notice path uses — `E_USAGE` keeps its one
    // meaning (a bad flag value or an impossible combination) and the
    // code↔exit-code pairing stays intact. Only this path prints the human
    // `reason:` line, so git's own text travels on `reason`.
    const detail =
      err instanceof Error
        ? err.message
        : "Stage the task's paths with 'git add' and retry.";
    return {
      ok: false,
      error: {
        code: "GIT_COMMIT_FAILED",
        message:
          "git commit failed — ensure changes are staged with 'git add'",
        suggestion: detail,
        ...(err instanceof Error ? { reason: err.message } : {}),
      },
    };
  }
  if (!result.ok) {
    // Nothing was written on this path either, so this is a refusal, not a
    // partial success: the task record is untouched.
    return {
      ok: false,
      error: {
        code: "GIT_COMMIT_FAILED",
        message: result.error,
        suggestion:
          "Stage the task's paths with 'git add' and retry the commit.",
      },
    };
  }

  // Auto-push is a best-effort VCS side-effect — the commit above already
  // landed, and a failed push can be retried separately. It still RUNS
  // under `--json`: what `--json` suppresses is the human progress lines,
  // not the push itself. A linked HEAD created no new commit, so there is
  // nothing to push.
  const { loadSettings } = await import("../settings.js");
  const commitSettings = loadSettings(ctx.projectDir);
  const autoPush: CommitAutoPushReport =
    commitSettings.autoPush && !result.linkedExisting
      ? {
          attempted: true,
          ...tryAutoPush(ctx.projectDir, {
            captureOutput: input.capturePushOutput,
          }),
        }
      : { attempted: false, ok: true };

  return {
    ok: true,
    data: {
      dryRun: false,
      taskId: resolvedId,
      taskTitle: resolvedTitle,
      ...(resolvedType !== undefined ? { taskType: resolvedType } : {}),
      message: commitMsg,
      sha: result.sha,
      linkedExisting: result.linkedExisting,
      committed: result.committed,
      foreign: result.foreign,
      autoPush,
    },
  };
}
