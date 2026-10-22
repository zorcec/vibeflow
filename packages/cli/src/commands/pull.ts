/**
 * `vibeflow pull` — the inverse of `push`: fetch the board's full archive
 * and merge it into the LOCAL store, so the project works fully in local
 * mode afterwards with all tasks.
 *
 * Option parsing, banner, board-scope and exit-code conventions mirror
 * `commands/push.ts` deliberately: the two commands are one round trip, and
 * a reader that knows one knows the other.
 *
 *   vibeflow pull [dir] [--board <id>] [--out <dir>] [--prefer-remote]
 *                  [--prefer-local] [--dry-run] [--json]
 *
 * - `[dir]` (default `.`) is the project whose `.vibeflow/` store is read;
 *   `--out <dir>` writes into a DIFFERENT project root instead (default:
 *   the same `[dir]` — the local store `push` consumes). Either way the
 *   archive lands in `<target>/.vibeflow/`, never beside it.
 * - The merge is ADDITIVE and LOCAL-WINS by default, with one exception:
 *   `status` follows the remote record — the board is the source of truth
 *   for workflow state, so a status set online lands locally on the next
 *   pull. `--prefer-remote` flips every conflicting field to the remote
 *   value; `--prefer-local` restores local-wins for `status` (an offline
 *   status edit survives the next pull, but the store stops following the
 *   board for it). Nothing is ever deleted: `pull` cannot destroy a local
 *   task, file, or local-only field.
 * - `--dry-run` fetches + verifies the archive and reports the plan, but
 *   writes nothing — the store stays byte-identical.
 */

import { taskReadNotices } from "../core/task-record-read.js";
import { planTaskStoreNormalize } from "../core/tasks.js";
import chalk from "chalk";
import { resolve } from "node:path";
import { readToken } from "../auth/token.js";
import { readWorkspace } from "../auth/workspace.js";
import {
  BoardScopeRequiredError,
  printBoardScopeRequired,
  resolveBoardScope,
} from "../auth/board-scope.js";
import { scopeHeaderFor } from "../auth/board-scope.js";
import { login } from "../auth/login.js";
import { getApiUrl } from "../core/api-url.js";
import { ExitCode } from "../core/exit-codes.js";
import type { OperationNotice } from "../core/operations.js";
import { saasFailure } from "../saas/failure.js";
import { fetchPullArchiveWithRetry } from "../saas/pull.js";
import {
  runPullFromBytes,
  emptyPullSummary,
  PullVerifyError,
  type PullMergeSummary,
} from "../saas/pull-archive.js";

export interface PullOptions {
  board?: string;
  out?: string;
  preferRemote?: boolean;
  /** Restore local-wins for `status` (default: status follows remote). */
  preferLocal?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /**
   * Suppress ALL console output (MCP/stdout-is-JSON-RPC callers). The
   * returned PullResult carries everything the human lines would print.
   * CLI-internal: no `--silent` flag exists on purpose.
   */
  silent?: boolean;
}

export interface PullResult {
  dryRun: boolean;
  added: number;
  merged: number;
  unchanged: number;
  conflicts: number;
  filesWritten: number;
  filesIdentical: number;
  filesKept: number;
  /** Tasks whose `status` followed the remote record this pull. */
  statusAdopted: number;
  /** Staged files the merged record disowned (linked/stale) — never written. */
  filesSkipped: number;
  missingBytes: number;
  board?: string;
  /**
   * Named `notices`, not `steps`: the same `{code, message}` objects the CLI
   * emits on every `--json` surface, so one parser reads them all.
   */
  notices: OperationNotice[];
}

/**
 * The write target for a pull: `--out` wins, otherwise the positional dir.
 * Both spell a PROJECT ROOT (the archive lands in `<target>/.vibeflow/`),
 * matching how `push [dir]` addresses the store it reads.
 */
export function resolvePullTarget(dir: string, out?: string): string {
  if (typeof out === "string" && out.trim() !== "") return resolve(out);
  return resolve(dir);
}

/** Human one-liner for a pull summary (mirrors push's condensed style). */
export function formatPullSummary(summary: PullMergeSummary): string {
  const parts = [
    `${summary.added} added`,
    `${summary.merged} merged`,
    `${summary.unchanged} unchanged`,
  ];
  if (summary.conflicts > 0) {
    // A status the pull adopted from the board is a decided divergence, not
    // a kept-local value — name which side won so the line stays honest.
    if (summary.statusAdopted > 0)
      parts.push(
        `${summary.conflicts} conflict(s) (${summary.statusAdopted} status followed remote, remainder kept local)`,
      );
    else parts.push(`${summary.conflicts} conflict(s) kept local`);
  }
  const files = [
    `${summary.filesWritten} file(s) written`,
    `${summary.filesIdentical} identical`,
    `${summary.filesKept} kept`,
    `${summary.filesSkipped} skipped`,
  ];
  if (summary.missingBytes > 0) files.push(`${summary.missingBytes} linked (no bytes)`);
  return `${parts.join(", ")}; files: ${files.join(", ")}`;
}

export async function pull(
  dir: string,
  opts: PullOptions,
): Promise<PullResult | void> {
  const projectDir = resolve(dir);
  const targetDir = resolvePullTarget(dir, opts.out);
  const dryRun = opts.dryRun === true;

  // ONE token read, up front — the same two-read login sequence push uses
  // (initial check → after login).
  const earlyToken = await readToken();

  let boardId: string | undefined;
  try {
    // One shared rule (ticket dabd2fb7): --board > saved workspace >
    // single-board auto-select. A 2+ board account with nothing selected
    // refuses here — a wrong-board pull would merge a foreign board's tasks
    // into the local store.
    boardId =
      (await resolveBoardScope(opts.board ?? null, {
        hasToken: async () => Boolean(earlyToken),
      })) ?? undefined;
  } catch (err) {
    if (!(err instanceof BoardScopeRequiredError)) throw err;
    const silent = opts.silent === true;
    if (opts.json) {
      console.log(
        JSON.stringify({
          ok: false,
          code: err.code,
          message: err.message,
          boards: err.boards,
        }),
      );
    }
    if (!silent) printBoardScopeRequired(err);
    process.exitCode = ExitCode.GENERAL;
    return {
      dryRun,
      added: 0,
      merged: 0,
      unchanged: 0,
      conflicts: 0,
      filesWritten: 0,
      filesIdentical: 0,
      filesKept: 0,
      statusAdopted: 0,
      filesSkipped: 0,
      missingBytes: 0,
      board: "(no board selected)",
      notices: [{ code: "SCOPE_REQUIRED", message: err.message }],
    };
  }
  const boardLabel =
    (await readWorkspace().catch(() => null))?.name ?? boardId ?? "(no board selected)";

  let token = earlyToken;
  if (!token) {
    // The MCP caller cannot drive an interactive login: refuse instead of
    // prompting on a machine with no TTY (stdout may be JSON-RPC).
    if (opts.silent === true) {
      process.exitCode = ExitCode.AUTH;
      return {
        dryRun,
        ...emptyPullSummary(),
        board: boardLabel,
        notices: [
          {
            code: "E_NOT_AUTHENTICATED",
            message: "Not logged in. Run `vibeflow auth login` and retry.",
          },
        ],
      };
    }
    console.log(chalk.yellow("  Not logged in. Starting login flow..."));
    await login();
    token = await readToken();
    if (!token) {
      console.error(chalk.red("  Login failed. Please run `vibeflow auth login` and try again."));
      process.exitCode = ExitCode.AUTH;
      return;
    }
  }

  if (!boardId) {
    const message =
      "No board selected: pass --board <boardId> or run `vibeflow auth login` to bind a default board.";
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, code: "SCOPE_REQUIRED", message }));
    } else if (opts.silent !== true) {
      console.error(chalk.red(`  ${message}`));
    }
    process.exitCode = ExitCode.GENERAL;
    return {
      dryRun,
      added: 0,
      merged: 0,
      unchanged: 0,
      conflicts: 0,
      filesWritten: 0,
      filesIdentical: 0,
      filesKept: 0,
      statusAdopted: 0,
      filesSkipped: 0,
      missingBytes: 0,
      board: boardLabel,
      notices: [{ code: "SCOPE_REQUIRED", message }],
    };
  }

  const apiUrl = getApiUrl();
  if (opts.silent !== true) {
    if (!dryRun) {
      console.log(chalk.cyan(`  Pulling board ${boardLabel} into ${targetDir}...`));
    } else {
      console.log(
        chalk.cyan(`  Dry run: fetching board ${boardLabel} archive (writing nothing)...`),
      );
    }
  }

  const fetched = await fetchPullArchiveWithRetry({
    apiUrl,
    token,
    // The resolved `--board` id scopes this fetch (ticket 605e503c): the
    // saved-workspace peek is empty in login-less flows (CI, throwaway
    // HOME), and an unscoped fetch answers 422 SCOPE_REQUIRED once the
    // account holds more than one board.
    headers: scopeHeaderFor(boardId),
    boardId,
  });

  if (!fetched.ok) {
    const failure = saasFailure({
      code: "HTTP_ERROR",
      ...(fetched.status === null ? {} : { status: fetched.status }),
      ...(fetched.serverCode ? { serverCode: fetched.serverCode } : {}),
    });
    // A retry loop already ran inside the fetch for transient failures; what
    // returns here is final. Plan refusals and caps are non-retryable by
    // construction (see saas/failure.ts) — the message says the fix.
    const detail =
      fetched.serverCode !== null
        ? ` (server: ${fetched.serverCode})`
        : fetched.status !== null
          ? ` (HTTP ${fetched.status})`
          : "";
    const message = `${failure.code === "E_PLAN_REQUIRED" ? failure.suggestion ?? "Export not allowed." : `Pull failed${detail}.`}${failure.suggestion && failure.code !== "E_PLAN_REQUIRED" ? ` ${failure.suggestion}` : ""}`;
    if (opts.json) {
      console.log(
        JSON.stringify({
          ok: false,
          code: failure.code,
          message,
          retryable: failure.retryable,
          ...(failure.suggestion ? { suggestion: failure.suggestion } : {}),
        }),
      );
    } else if (opts.silent !== true) {
      console.error(chalk.red(`  ${message}`));
      if (failure.suggestion && failure.code !== "E_PLAN_REQUIRED") {
        console.error(chalk.dim(`  ${failure.suggestion}`));
      }
      if (!failure.retryable) {
        console.error(chalk.dim("  Not retrying: this refusal is final for this board."));
      }
    }
    process.exitCode =
      failure.code === "E_NOT_AUTHENTICATED" ? ExitCode.AUTH : ExitCode.GENERAL;
    return {
      dryRun,
      added: 0,
      merged: 0,
      unchanged: 0,
      conflicts: 0,
      filesWritten: 0,
      filesIdentical: 0,
      filesKept: 0,
      statusAdopted: 0,
      filesSkipped: 0,
      missingBytes: 0,
      board: boardLabel,
      notices: [{ code: failure.code, message }],
    };
  }

  let summary: PullMergeSummary;
  try {
    ({ summary } = await runPullFromBytes(targetDir, fetched.bytes, {
      preferRemote: opts.preferRemote === true,
      preferLocal: opts.preferLocal === true,
      dryRun,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A verification failure throws before the first store write, so the
    // "nothing written" claim holds; any other throw (I/O mid-apply) may
    // have left partial writes behind and must not make that claim.
    const verified = err instanceof PullVerifyError;
    const prefix = verified
      ? "Pull archive failed verification"
      : "Pull failed while applying the archive";
    const aftermath = verified
      ? "Nothing was written to the local store."
      : "The pull stopped partway — some changes may already have been written.";
    if (opts.json) {
      console.log(
        JSON.stringify({ ok: false, code: "PULL_VERIFY_FAILED", message, retryable: false }),
      );
    } else if (opts.silent !== true) {
      console.error(chalk.red(`  ${prefix}: ${message}`));
      console.error(chalk.dim(`  ${aftermath}`));
    }
    process.exitCode = ExitCode.GENERAL;
    return {
      dryRun,
      ...emptyPullSummary(),
      board: boardLabel,
      notices: [{ code: "PULL_VERIFY_FAILED", message }],
    };
  }

  const line = dryRun
    ? `  Dry run: would pull ${formatPullSummary(summary)} (nothing written).`
    : `  ✓ Pulled ${formatPullSummary(summary)}.`;
  // Ticket 74d9c46f: a quarantined local record is skipped by the merge
  // above (its slot keeps its bytes, counted as unchanged+conflict) — that
  // skip must be LOUD, not silent. ONE warning per run: the count and the
  // first reason, never one line per file. Shared shape with list/push
  // (taskReadNotices), on stderr in every mode so --json cannot swallow it,
  // and in the --json envelope + result notices. A warning is not a failure:
  // the exit code stays 0 on a successful run.
  const recordNotices = taskReadNotices(
    planTaskStoreNormalize(targetDir).quarantined,
  );
  if (opts.silent !== true) {
    for (const notice of recordNotices) console.error(notice.message);
    if (opts.json) {
      console.log(
        JSON.stringify({
          dryRun,
          added: summary.added,
          merged: summary.merged,
          unchanged: summary.unchanged,
          conflicts: summary.conflicts,
          filesWritten: summary.filesWritten,
          filesIdentical: summary.filesIdentical,
          filesKept: summary.filesKept,
          statusAdopted: summary.statusAdopted,
          filesSkipped: summary.filesSkipped,
          missingBytes: summary.missingBytes,
          board: boardLabel,
          ...(recordNotices.length > 0 ? { notices: recordNotices } : {}),
        }),
      );
    } else {
      console.log(chalk.green(line));
      if (summary.missingBytes > 0) {
        console.log(
          chalk.dim(
            `  ${summary.missingBytes} linked file ref(s) have no server bytes and were kept as-is.`,
          ),
        );
      }
      if (summary.filesSkipped > 0) {
        console.log(
          chalk.dim(
            `  ${summary.filesSkipped} staged file(s) skipped (linked cover or stale row — no bytes written).`,
          ),
        );
      }
      console.log(chalk.dim(`  Board: ${boardLabel}`));
    }
  }

  const notices: OperationNotice[] = dryRun
    ? [{ code: "DRY_RUN", message: "No changes were made" }]
    : [{ code: "PULL_COMPLETED", message: "Pull completed" }];
  notices.push(...recordNotices);
  void projectDir;
  return {
    dryRun,
    added: summary.added,
    merged: summary.merged,
    unchanged: summary.unchanged,
    conflicts: summary.conflicts,
    filesWritten: summary.filesWritten,
    filesIdentical: summary.filesIdentical,
    filesKept: summary.filesKept,
    statusAdopted: summary.statusAdopted,
    filesSkipped: summary.filesSkipped,
    missingBytes: summary.missingBytes,
    board: boardLabel,
    notices,
  };
}
