import { taskReadNotices, type TaskReadFinding } from "../core/task-record-read.js";
import chalk from "chalk";
import { unlinkSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { prepareTaskRecordsForPush } from "../core/tasks.js";
import { listFiles, getFilesDir } from "../core/files.js";
import { readToken } from "../auth/token.js";
import { readWorkspace } from "../auth/workspace.js";
import {
  BoardScopeRequiredError,
  printBoardScopeRequired,
  resolveBoardScope,
} from "../auth/board-scope.js";
import { applyPushLinks, createTasksOneByOne, formatPushRefusalSummary, formatPushStopLine, formatSkippedLinks, login, createTaskPushProgressReporter, PUSH_429_MAX_RESUMES, type PushLoopResult } from "../auth/login.js";
import { probeImportCapability, evaluateBatchPreflight, importBatchTree, readBatchCheckpoint, topoOrderImportTasks, fetchOnlineTaskIndex, type ImportProbeResult, type ImportTaskInput } from "../saas/batch-push.js";
import { runDeltaPush } from "../saas/delta-run.js";
import { PROTO_DIR, SCREENSHOTS_DIR } from "../core/types.js";
import { ExitCode } from "../core/exit-codes.js";
import type { OperationNotice } from "../core/operations.js";
import { maybeCompressForUpload } from "../saas/compression.js";
import { getApiUrl, surfacePath } from "../core/api-url.js";
import { scopeHeadersFromSaved } from "../auth/board-scope.js";

type ImportResult = {
  imported: number;
  /** Re-push matches (ticket 9309ea70): resolved to existing rows. */
  existing: number;
  skipped: number;
  ids: string[];
  workspaceId: string;
  boardId: string;
  /** Map of cliTaskId → saasTaskId returned by the server */
  idMap?: Record<string, string>;
  /** POSTs actually attempted (differs from task count after early stop) */
  attempted: number;
  /** Refusals grouped by status + server code, in first-seen order */
  failures: PushLoopResult["failures"];
  stoppedEarly: PushLoopResult["stoppedEarly"];
  stopMessage: PushLoopResult["stopMessage"];
  retryAfter: PushLoopResult["retryAfter"];
  /** Tasks skipped WHOLE by the per-task atomicity partition (present
   * only on the import path): never attempted, never marked pushed —
   * the next run re-attempts them. */
  skippedTasks?: Array<{ localId: string; reason: string }>;
  /** Tree-import tallies (present only on the import path). */
  linksApplied?: number;
  linksFailed?: number;
  failedLinks?: Array<{ clientId: string; reason: string }>;
  filesUploaded?: number;
  filesFailed?: number;
  filesSkippedPresent?: number;
  failedFiles?: Array<{ clientId: string; name: string; reason: string }>;
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderProgressBar(done: number, total: number, width = 24): string {
  const filled = Math.round((done / total) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return `[${bar}]`;
}

/** Local → remote id pairs for the file phase (built from the push idMap). */
export interface PushedFileMapping {
  localId: string;
  remoteId: string;
}

export async function uploadTaskFiles(
  apiUrl: string,
  token: string,
  projectDir: string,
  taskMappings: PushedFileMapping[],
): Promise<{ uploaded: number; failed: number; failedFiles: Array<{ name: string; reason: string }> }> {
  const allJobs: Array<{ remoteId: string; name: string; filePath: string; size: number; system: boolean }> = [];

  for (const { localId, remoteId } of taskMappings) {
    const files = listFiles(projectDir, localId);
    for (const f of files) {
      // Linked refs are never uploaded (no server bytes by design — same
      // rule as collectImportInputs above, so the legacy path cannot
      // create rows the record disowns either).
      if (typeof f.linkedPath === "string" && f.linkedPath.length > 0) continue;
      const absPath = join(getFilesDir(projectDir, localId), f.name);
      if (existsSync(absPath)) {
        allJobs.push({ remoteId, name: f.name, filePath: absPath, size: f.size, system: f.system === true });
      }
    }
  }

  if (allJobs.length === 0) return { uploaded: 0, failed: 0, failedFiles: [] };

  const totalFiles = allJobs.length;
  const totalBytes = allJobs.reduce((s, j) => s + j.size, 0);
  console.log(chalk.cyan(`\n  Uploading ${totalFiles} file(s) (${formatBytes(totalBytes)})...`));

  let uploaded = 0;
  let failed = 0;
  let doneBytes = 0;
  const startMs = Date.now();
  const failedFiles: Array<{ name: string; reason: string }> = [];

  for (const job of allJobs) {
    const pct = Math.round((uploaded / totalFiles) * 100);
    const bar = renderProgressBar(uploaded, totalFiles);
    const elapsedSec = (Date.now() - startMs) / 1000;
    const rate = doneBytes / Math.max(elapsedSec, 0.01);
    const remaining = totalBytes - doneBytes;
    const etaSec = rate > 0 ? Math.ceil(remaining / rate) : 0;
    const etaStr = etaSec > 60 ? `${Math.ceil(etaSec / 60)}m` : `${etaSec}s`;
    process.stdout.write(`\r  ${bar} ${pct}%  ${job.name.slice(0, 28)}  ETA: ${etaStr}   `);

    try {
      const data = readFileSync(job.filePath);
      // Single-encode: eligible text artifacts travel already brotli-compressed
      // (q5) and the server stores the received bytes verbatim as the at-rest
      // form. The `x-content-encoding` header declares the payload form per
      // file — a plain HTTP `Content-Encoding` header is deliberately NOT used
      // so no intermediary ever tries to decode the body in transit.
      const { bytes: payload, contentEncoding } = maybeCompressForUpload(
        job.name,
        data,
      );
      const res = await fetch(
        // Cloud-only path: push runs Bearer-authenticated against the SaaS
        // base from getApiUrl(), so the mode is always "cloud" → v0 files op.
        `${apiUrl}${surfacePath("cloud", `/api/tasks/${encodeURIComponent(job.remoteId)}/files`)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(await scopeHeadersFromSaved()),
            "Content-Type": "application/octet-stream",
            "x-filename": encodeURIComponent(job.name),
            ...(job.system ? { "x-file-system": "1" } : {}),
            ...(contentEncoding ? { "x-content-encoding": contentEncoding } : {}),
          },
          // Copy into a plain Uint8Array: brotli output is typed
          // Buffer<ArrayBufferLike>, which fetch's BodyInit rejects, while
          // readFileSync returns a NonSharedBuffer that it accepts.
          body: new Uint8Array(payload),
        },
      );
      if (res.ok) {
        uploaded++;
        doneBytes += job.size;
      } else {
        failed++;
        failedFiles.push({ name: job.name, reason: `HTTP ${res.status}` });
      }
    } catch (err) {
      failed++;
      failedFiles.push({ name: job.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const bar = renderProgressBar(totalFiles, totalFiles);
  process.stdout.write(`\r  ${bar} 100%  Done${" ".repeat(40)}\n`);
  return { uploaded, failed, failedFiles };
}

/**
 * Collect import inputs for the tree-import push (ticket bulk-429): one
 * entry per local task with its file attachments resolved to absolute
 * paths (missing files are skipped here — the record still travels).
 * Shared by the standalone push and the login-time push so file
 * collection cannot drift between the two paths.
 */
export function collectImportInputs(
  projectDir: string,
  taskList: Array<{ id?: string } & Record<string, unknown>>,
): ImportTaskInput[] {
  return taskList
    .filter((t): t is { id: string } & Record<string, unknown> => typeof t.id === "string" && t.id.length > 0)
    .map((t) => ({
      localId: t.id,
      /* SAFETY: entries are parsed task JSON objects (plus a filePath on the
         caller side) — the record cast is representation-preserving. */
      record: t as unknown as Record<string, unknown>,
      files: listFiles(projectDir, t.id)
        .filter((f) => {
          // Linked refs point outside the store BY DESIGN: the server holds
          // no bytes for them, so there is nothing to upload. Uploading the
          // target's bytes anyway creates a row the record disowns (the
          // server sanitizes `/` out of row names, so it can never match
          // the record's ref back) — and the task is then forced onto every
          // future push forever. The record (with its linkedPath ref) still
          // travels; only the bytes stay local.
          if (typeof f.linkedPath === "string" && f.linkedPath.length > 0) return false;
          const absPath = join(getFilesDir(projectDir, t.id), f.name);
          return existsSync(absPath);
        })
        .map((f) => ({
          name: f.name,
          filePath: join(getFilesDir(projectDir, t.id), f.name),
          size: f.size,
          system: f.system === true,
        })),
    }));
}

/**
 * Legacy file phase (pre-tree-import servers): sequential upload for
 * already-pushed tasks. Standalone `push` and the login-time push call
 * this — never inline uploader loops — so the wire format
 * (single-encode brotli + `x-content-encoding`) cannot drift between
 * the two paths. The tree-import path does NOT call this (files ride
 * the import call; server-side skip replaces the old client presence
 * check).
 *
 * Prints the Uploading/Uploaded/failed lines itself. Returns the
 * counts; the caller decides what a failure means (standalone push
 * fails loudly with exit code; login-time push only warns — auth
 * already succeeded and the files stay local for a later `push`).
 */
export async function uploadPushedFiles(
  apiUrl: string,
  token: string,
  projectDir: string,
  taskMappings: PushedFileMapping[],
): Promise<{
  uploaded: number;
  failed: number;
  failedFiles: Array<{ name: string; reason: string }>;
  skippedPresent: number;
}> {
  // Legacy sequential uploader (the tree-import path never calls this).
  const { uploaded, failed, failedFiles } = await uploadTaskFiles(
    apiUrl,
    token,
    projectDir,
    taskMappings,
  );
  if (uploaded > 0)
    console.log(chalk.green(`  ✓ Uploaded ${uploaded} file(s) to storage`));
  if (failed > 0) {
    // Stryker disable once StringLiteral: display message for upload failures
    console.log(chalk.yellow(`  ⚠ ${failed} file(s) failed to upload`));
    for (const f of failedFiles) {
      // Stryker disable once StringLiteral: display message for failed file
      console.log(chalk.dim(`    - ${f.name}: ${f.reason}`));
    }
  }
  return { uploaded, failed, failedFiles, skippedPresent: 0 };
}

export interface PushResult {
  dryRun: boolean;
  tasks: number;
  files: number;
  board?: string;
  /**
   * Distinct local tasks with at least one commits[] entry missing
   * `authorEmail`. REPORT ONLY — push never enriches commit attribution; the count points at `vibeflow authors link`.
   */
  tasksMissingCommitAuthorEmail?: number;
  /**
   * Named `notices`, not `steps`: this object was the push_tasks wire payload
   * (the MCP tool is now removed; the hidden CLI push still returns it), so
   * a `steps` key here would be the one place the push surface still used
   * the old name, and its values were bare strings. Same `{code, message}`
   * objects the CLI emits.
   */
  notices: OperationNotice[];
}

/**
 * Distinct tasks whose commits include at least one entry without a
 * non-empty `authorEmail` — the enrichment gap `vibeflow authors link`
 * fills. Read-only accounting for the push report; comment-id preflight is separate.
 */
export function countTasksMissingCommitAuthorEmail(
  tasks: Array<{ commits?: Array<{ authorEmail?: string; sha?: string }> }>,
): number {
  // Only commits that CAN be enriched are counted. `authors link` resolves a
  // sha through git history, so an entry with no sha (a record written by an
  // older flow, or a commit recorded before it was made) is unlinkable — warning
  // about it tells the user to run a command that reports "0 unresolved" and
  // fixes nothing. It is still a gap in the DATA; it is just not this gap.
  return tasks.filter((t) =>
    (t.commits ?? []).some(
      (c) =>
        typeof c.sha === "string" &&
        c.sha.trim() !== "" &&
        (!c.authorEmail || c.authorEmail.trim() === ""),
    ),
  ).length;
}

async function pushImpl(dir: string, reads: TaskReadFinding[], opts: { board?: string; workspace?: string; pruneLocal?: boolean; keepLocalFiles?: boolean; dryRun?: boolean; verbose?: boolean; json?: boolean }): Promise<PushResult | void> {
  const projectDir = resolve(dir);

  const taskList = prepareTaskRecordsForPush(projectDir, reads, opts.dryRun === true);
  const tasksMissingCommitAuthorEmail = countTasksMissingCommitAuthorEmail(taskList);
  if (taskList.length === 0) {
    // Stryker disable once StringLiteral: display message for no tasks
    console.log(chalk.dim("  No local tasks found. Nothing to push."));
    return {
      dryRun: !!opts.dryRun,
      tasks: 0,
      files: 0,
      tasksMissingCommitAuthorEmail: 0,
      notices: [
        { code: "NOTHING_TO_PUSH", message: "No local tasks found" },
      ],
    };
  }

  // ONE token read, up front: the scope resolver below reuses this probe
  // through deps.hasToken instead of reading the token again — push keeps
  // its original two-read login sequence (initial check → after login).
  const earlyToken = await readToken();

  let workspaceId: string | undefined;
  try {
    // One shared rule (ticket dabd2fb7): --board > --workspace (legacy) >
    // saved workspace > single-board auto-select. A 2+ board account with
    // nothing selected refuses here — a wrong-board push moves the whole
    // local store (1753 tasks) to the wrong board.
    workspaceId =
      (await resolveBoardScope(opts.board ?? opts.workspace ?? null, {
        hasToken: async () => Boolean(earlyToken),
      })) ??
      undefined;
  } catch (err) {
    if (!(err instanceof BoardScopeRequiredError)) throw err;
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
    printBoardScopeRequired(err);
    process.exitCode = ExitCode.GENERAL;
    return {
      dryRun: opts.dryRun === true,
      tasks: 0,
      files: 0,
      board: "(no board selected)",
      tasksMissingCommitAuthorEmail,
      notices: [{ code: "SCOPE_REQUIRED", message: err.message }],
    };
  }
  const boardLabel = workspaceId ? ((await readWorkspace().catch(() => null))?.name ?? workspaceId) : "(no board selected)";

  const apiUrl = getApiUrl();

  // ── Diff-based push: fetch online ids FIRST, push ONLY the unsynced ──
  // A re-push with nothing new is a no-op (no probe, no creates, no
  // deletions) — safe to run any time. `onlineIds === null` means the
  // diff is unknown (no token/board, or the listing failed): every local
  // task is attempted and the summary is the source of truth, said out loud.
  /**
   * A board-scope rejection (401/403/404) is NOT a transient listing failure.
   * Falling back to "push all local tasks" then fired 1746 creates at a board
   * that no longer exists, each refused with 403 — a progress bar that counts
   * attempts while nothing lands anywhere. Measured: after the owner deleted
   * a board the saved pointer still named it, and push churned through the
   * whole store before anyone noticed. Stop before the first write instead.
   */
  const boardScopeFailure = (err: unknown): number | null => {
    const m = err instanceof Error ? err.message.match(/board listing failed: HTTP (\d{3})/) : null;
    if (m === null) return null;
    const status = Number(m[1]);
    return status === 401 || status === 403 || status === 404 ? status : null;
  };
  const refuseUnreachableBoard = (status: number): PushResult => {
    console.error(
      chalk.red(
        `  Board ${workspaceId ?? "(none)"} is not accessible (HTTP ${status}) — it may have been deleted, or this token belongs to another account.`,
      ),
    );
    console.error(
      chalk.dim("  Nothing was pushed. Run `vibeflow auth login` to pick a live board, then push again."),
    );
    process.exitCode = ExitCode.GENERAL;
    return {
      dryRun: opts.dryRun === true,
      tasks: 0,
      files: 0,
      board: boardLabel,
      tasksMissingCommitAuthorEmail,
      notices: [{ code: "BOARD_UNAVAILABLE", message: `Board not accessible (HTTP ${status})` }],
    };
  };

  let onlineIndex: Map<string, number | null> | null = null;
  let boardListed = false;
  let boardListFailed = false;
  if (earlyToken && workspaceId) {
    try {
      onlineIndex = await fetchOnlineTaskIndex(apiUrl, earlyToken, workspaceId);
      boardListed = true;
    } catch (err) {
      const scopeStatus = boardScopeFailure(err);
      if (scopeStatus !== null) return refuseUnreachableBoard(scopeStatus);
      boardListFailed = true;
    }
  }

  // ── Capability probe, hoisted ────────────────────────────────────────
  // The probe decides whether tasks ALREADY on the board are re-sent for
  // reconciliation, so it must happen BEFORE the diff is filtered. Before this
  // was hoisted the branch below returned "Everything is already pushed" first,
  // so on a healthy board the repair could never run: only creates travelled,
  // and a task whose comments an older lossy import dropped was skipped for
  // ever. Probe failures keep the old hard failure (401/403/5xx must abort —
  // falling back would "push" nothing while the summary looked fine).
  let probeResult: ImportProbeResult | null = null;
  let probeError: unknown = null;
  if (earlyToken) {
    try {
      probeResult = await probeImportCapability(apiUrl, earlyToken, workspaceId ?? undefined);
    } catch (err) {
      probeError = err;
    }
  }
  const losslessServer = probeResult?.supported === true && probeResult.lossless;

  /** Local file count for a task — what the remote `fileCount` is compared to. */
  const localFileCount = (taskId: string): number => {
    try {
      return listFiles(projectDir, taskId).length;
    } catch {
      return 0;
    }
  };

  // FILE-GAP RETRY (ticket push-diff-atomic follow-up): a task that exists
  // remotely but whose FILES failed to upload must be pushed again. The task
  // row comes back `existing` (no duplicate) and only the missing bytes
  // travel, because the server skips files it already has. Without this, a
  // file failure was permanent: measured on prod, 1746 tasks synced while
  // only 601 of ~790 files were on the board and push said "everything is
  // already pushed". Comparison is by COUNT (names would cost one GET per
  // task); remote > local means files were deleted locally, not a gap.
  const needsFileSync = (taskId: string): boolean => {
    if (onlineIndex === null) return false;
    const remoteCount = onlineIndex.get(taskId);
    if (remoteCount === undefined) return false; // not on the board at all
    if (remoteCount === null) return false; // no count reported — assume synced
    return localFileCount(taskId) > remoteCount;
  };

  /**
   * The push set.
   *
   * A task is pushed when it is not on the board, when it is short of files,
   * or when the server mirrors whole records — the last case is what turns a
   * re-push into a REPAIR: an existing task is sent again so the server can
   * reconcile comments, commits, links and `openedBy` that an older lossy
   * import silently dropped. A server without `lossless` keeps the
   * conservative behaviour (only fresh tasks and file gaps travel).
   */
  const needsPush = (taskId: string): boolean =>
    onlineIndex === null ||
    !onlineIndex.has(taskId) ||
    needsFileSync(taskId) ||
    losslessServer;

  const pushTasks =
    onlineIndex !== null ? taskList.filter((t) => needsPush(t.id!)) : taskList;
  const fileSyncOnly = pushTasks.filter(
    (t) => onlineIndex !== null && onlineIndex!.has(t.id!),
  );
  const alreadyOnBoard = taskList.length - pushTasks.length;

  // Files that would be uploaded this run (push set only). Tasks pulled in
  // PURELY for a file gap are called out separately so the summary never
  // reads as "everything is new".
  const describeFileSync = (): string => {
    if (fileSyncOnly.length === 0) return "";
    const n = fileSyncOnly.length;
    return ` (${n} already on the board and re-pushed only to sync missing files)`;
  };

  // Count files that would be uploaded (push set only — already-synced
  // tasks and their files are never touched by this run).
  let fileCount = 0;
  for (const task of pushTasks) {
    const files = listFiles(projectDir, task.id!);
    fileCount += files.length;
  }

  // ── Dry-run: preview only, no writes, no deletions ───────────────────
  // Reports the SAME diff as a live push (online-ids GET; best-effort
  // preflight GET for the atomic-skip preview) — read-only calls only.
  if (opts.dryRun) {
    if (onlineIndex !== null) {
      if (pushTasks.length === 0) {
        console.log(chalk.green(`  Everything is already pushed (${taskList.length} tasks on the board, all files synced).`));
        return {
          dryRun: true,
          tasks: 0,
          files: 0,
          board: boardLabel,
          tasksMissingCommitAuthorEmail,
          notices: [{ code: "ALREADY_PUSHED", message: "Everything is already pushed" }],
        };
      }
      // Stryker disable once StringLiteral: display message for dry-run
      console.log(chalk.cyan(`  Dry run: ${pushTasks.length} task(s) to push (${alreadyOnBoard} already on the board)${describeFileSync()}, ${fileCount} file(s), board: ${boardLabel}`));
      return {
        dryRun: true,
        tasks: pushTasks.length,
        files: fileCount,
        board: boardLabel,
        tasksMissingCommitAuthorEmail,
        notices: [{ code: "DRY_RUN", message: "No changes were made" }],
      };
    }
    // Stryker disable once StringLiteral: display message for dry-run
    console.log(chalk.cyan(`  Dry run: ${taskList.length} task(s), ${fileCount} file(s), board: ${boardLabel}`));
    if (boardListFailed) {
      console.log(chalk.yellow("  Could not read the board — showing all local tasks (the push summary is the source of truth)."));
    }
    return {
      dryRun: true,
      tasks: taskList.length,
      files: fileCount,
      board: boardLabel,
      tasksMissingCommitAuthorEmail,
      notices: [{ code: "DRY_RUN", message: "No changes were made" }],
    };
  }

  // Auth check: only required for live (non-dry-run) push
  let token = earlyToken;
  if (!token) {
    // Stryker disable once StringLiteral: display message for login flow
    console.log(chalk.yellow("  Not logged in. Starting login flow..."));
    await login();
    token = await readToken();
    if (!token) {
      // Stryker disable once StringLiteral: display message for login failure
      console.error(chalk.red("  Login failed. Please run `vibeflow auth login` and try again."));
      process.exitCode = ExitCode.AUTH;
      return;
    }
  }

  // The board may have changed between the dry-run-style early diff and
  // now (login flow just ran): re-fetch when we have a board. Cheap,
  // read-only, and keeps the no-op honest.
  if (token && workspaceId && !boardListed) {
    try {
      onlineIndex = await fetchOnlineTaskIndex(apiUrl, token, workspaceId);
      boardListed = true;
      boardListFailed = false;
    } catch (err) {
      const scopeStatus = boardScopeFailure(err);
      if (scopeStatus !== null) return refuseUnreachableBoard(scopeStatus);
      boardListFailed = true;
    }
  }
  // Recompute the diff on the freshest index (the login flow may have just
  // run). `needsFileSync` is the same rule as the early pass: a task that is
  // on the board but short of local files is re-pushed so its missing bytes
  // finally upload.
  const livePushTasks =
    onlineIndex !== null ? taskList.filter((t) => needsPush(t.id!)) : taskList;
  const liveAlreadyOnBoard = taskList.length - livePushTasks.length;
  let liveFileCount = fileCount;
  if (livePushTasks.length !== pushTasks.length) {
    liveFileCount = 0;
    for (const task of livePushTasks) {
      liveFileCount += listFiles(projectDir, task.id!).length;
    }
  }
  if (onlineIndex !== null && livePushTasks.length === 0) {
    console.log(chalk.green(`  Everything is already pushed (${taskList.length} tasks on the board, all files synced).`));
    return {
      dryRun: false,
      tasks: 0,
      files: 0,
      board: boardLabel,
      tasksMissingCommitAuthorEmail,
      notices: [{ code: "ALREADY_PUSHED", message: "Everything is already pushed" }],
    };
  }
  if (onlineIndex !== null) {
    // Stryker disable once StringLiteral: display message for task count
    console.log(chalk.cyan(`  ${livePushTasks.length} task(s) to push (${liveAlreadyOnBoard} already on the board)${describeFileSync()}. Pushing online...`));
  } else {
    // Stryker disable once StringLiteral: display message for task count
    console.log(chalk.cyan(`  Found ${taskList.length} local task(s). Pushing online...`));
    if (boardListFailed) {
      console.log(chalk.yellow("  Could not read the board — attempting push of all local tasks."));
    }
  }

  // Tree-import push (ticket bulk-429): the capability probe decides.
  // A 404 on GET /api/v0/tasks/import — or a 200 WITHOUT the preflight
  // envelope (old routers prefix-match /import onto the list handler and
  // answer 200 `{ items, nextCursor }`) — means an old server: fall back
  // to the proven phases below (one POST per task, per link, per file),
  // byte-identical to before. On a new server one multipart call carries
  // a whole subtree (tasks + parent links + files, 1 write unit), so
  // children can never be orphaned by a failed follow-up phase. Any
  // OTHER probe failure (401/403/5xx) aborts inside the same catch —
  // falling back would "push" 0 tasks while the post-push deletion
  // still wipes locals.
  let result: ImportResult;
  // Legacy fallback flag: the links + files phases below run ONLY on
  // the fallback path — the import path carries both in every call.
  let legacyPath = false;
  try {
    // Minimal push progress (ticket e4049164): one \r line on a TTY
    // (counter + bar + pct + ETA), sparse lines when piped, all on
    // stderr so piped output and --json stay clean.
    const onProgress = createTaskPushProgressReporter(livePushTasks.length);
    // 429 waits are user-visible stalls (ticket 99cf6943): say how long
    // and which resume — a silent 120s pause reads as hung.
    const onWait = (waitMs: number, resume: number): void => {
      console.log(
        chalk.yellow(
          `  Rate limited — waiting ${Math.ceil(waitMs / 1000)}s before resuming (resume ${resume}/${PUSH_429_MAX_RESUMES})…`,
        ),
      );
    };
    // SAFETY: listTasksWithPaths returns parsed task JSON objects plus a
    // filePath string — each entry spreads as a plain record into the
    // import manifest, so the record cast is representation-preserving.
    const records = livePushTasks as unknown as Array<Record<string, unknown>>;
    // Reuse the hoisted probe (it already ran against the same URL/token);
    // a probe failure is still fatal here, exactly as before.
    if (probeError !== null) throw probeError;
    const probe = probeResult ?? (await probeImportCapability(apiUrl, token, workspaceId ?? undefined));
    const toImportResult = (loop: PushLoopResult): ImportResult => ({
      imported: loop.imported,
      existing: loop.existing,
      skipped: loop.skipped,
      ids: Object.values(loop.idMap),
      workspaceId: workspaceId ?? "",
      boardId: workspaceId ?? "",
      idMap: loop.idMap,
      attempted: loop.attempted,
      failures: loop.failures,
      stoppedEarly: loop.stoppedEarly,
      stopMessage: loop.stopMessage,
      retryAfter: loop.retryAfter,
    });
    if (probe.supported === false) {
      result = toImportResult(
        await createTasksOneByOne(apiUrl, token, workspaceId, records, onProgress, { onWait }),
      );
      legacyPath = true;
    } else {
      // Quota preflight: refuse-or-confirm BEFORE chunk one.
      // Refuse-only (no prompt): the login-time push cannot prompt and
      // scripts cannot answer — and a push that cannot fit must never
      // start. The message carries exact numbers; resume via the
      // checkpoint covers the retry-after-quota path. Order is the
      // topo order the loop checkpoints against, so resume compares
      // like-for-like.
      const inputs = topoOrderImportTasks(
        collectImportInputs(
          projectDir,
          // SAFETY: listTasksWithPaths returns parsed task JSON objects —
          // each entry spreads as a plain record, so the cast is
          // representation-preserving.
          livePushTasks as unknown as Array<{ id?: string } & Record<string, unknown>>,
        ),
      );
      const order = inputs.map((t) => t.localId);
      const existing = readBatchCheckpoint(projectDir);
      const resumed =
        existing !== null &&
        existing.order.length === order.length &&
        existing.order.every((id, i) => id === order[i])
          ? existing.attempted
          : 0;
      // Capacity is spent per CREATE, not per record: a reconciliation of a
      // task that already exists on the board inserts no row. Counting the
      // whole push set would refuse a repair that fits easily.
      const newTasks = onlineIndex === null
        ? inputs.length
        : inputs.filter((t) => !onlineIndex!.has(t.localId)).length;
      const refusal = evaluateBatchPreflight(
        Math.max(0, newTasks - resumed),
        probe.preflight,
      );
      if (refusal !== null) {
        console.error(chalk.red(`  ${refusal}`));
        process.exitCode = ExitCode.GENERAL;
        return;
      }
      // Delta first (when the board advertises the inventory route): send only
      // what the board does not already hold. `null` means an old server, and
      // the multipart loop below then runs exactly as it did before.
      const delta =
        workspaceId === undefined
          ? null
          : await runDeltaPush(apiUrl, token, workspaceId, inputs, {
              headers: await scopeHeadersFromSaved(),
              // Resolve missing commit emails from the project's own git
              // history — the repo the push is running in, not the CLI's cwd.
              gitCwd: projectDir,
            });
      if (delta !== null) {
        result = {
          imported: delta.imported,
          existing: delta.unchanged,
          skipped: 0,
          ids: [],
          workspaceId: workspaceId ?? "",
          boardId: workspaceId ?? "",
          idMap: {},
          attempted: delta.imported + delta.unchanged,
          failures: [],
          stoppedEarly: null,
          stopMessage: null,
          retryAfter: null,
          skippedTasks: [],
          linksApplied: 0,
          linksFailed: 0,
          failedLinks: [],
          filesUploaded: delta.filesSent,
          filesFailed: 0,
          filesSkippedPresent: delta.filesDropped,
          failedFiles: [],
        };
      } else {
        const loop = await importBatchTree(apiUrl, token, workspaceId, inputs, {
          onProgress,
          projectDir,
          preflight: probe.preflight,
          retry429: { onWait },
        });
        result = {
          ...toImportResult(loop),
          skippedTasks: loop.skippedTasks,
          linksApplied: loop.linksApplied,
          linksFailed: loop.linksFailed,
          failedLinks: loop.failedLinks,
          filesUploaded: loop.filesUploaded,
          filesFailed: loop.filesFailed,
          filesSkippedPresent: loop.filesSkippedPresent,
          failedFiles: loop.failedFiles,
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stryker disable once StringLiteral: display message for network error
    console.error(chalk.red(`  Network error: ${msg}`));
    process.exitCode = ExitCode.GENERAL;
    return;
  }

  // Stryker disable once StringLiteral: display message for push success
  // Condensed summary (ticket e4049164): the pushed line carries the TRUE
  // refusal groups when any (dec52322 formatter, unchanged — never
  // "already imported"), and the stop line shares one red line with the
  // not-attempted count. Every number from dec52322 survives, tighter.
  const refused =
    result.skipped > 0 ? ` — ${formatPushRefusalSummary(result)}` : "";
  const already =
    result.existing > 0 ? ` (${result.existing} already existed)` : "";
  console.log(chalk.green(`  ✓ Pushed ${result.imported} task(s) online${already}${refused}`));
  const stopLine = formatPushStopLine(result);
  if (stopLine !== null) {
    // Stryker disable once StringLiteral: display message for early stop
    const remaining = livePushTasks.length - result.attempted;
    const unattempted =
      remaining > 0 ? ` (${remaining} task(s) not attempted.)` : "";
    console.log(chalk.red(`  ${stopLine}${unattempted}`));
  }

  // Legacy links phase (pre-tree-import servers ONLY): replay stored
  // links with targets translated from local ids to the created cloud
  // ids from `idMap`, via POST /api/v0/tasks/{id}/links ({ taskId, type }
  // — the v0 add-link op). The import path carries every parent link in
  // every call, so this phase is skipped there — nothing is silently
  // lost either way. Local mode is untouched (cloud push only).
  let filesFailed = 0;
  let legacyLinksApplied = 0;
  let legacyLinksSkipped: Array<{ from: string; to: string; type: string; reason: string }> = [];
  let legacySkippedSummary = "";
  if (legacyPath) {
    // SAFETY: listTasksWithPaths returns parsed task JSON objects plus a
    // filePath string — each entry spreads as a plain record, so the cast is
    // representation-preserving (same invariant as the phase-1 loop above).
    const linkRecords = livePushTasks as unknown as Array<Record<string, unknown>>;
    const linkResult = await applyPushLinks(apiUrl, token, linkRecords, result.idMap ?? {});
    legacyLinksApplied = linkResult.applied;
    legacyLinksSkipped = linkResult.skipped;
    if (linkResult.applied > 0) {
      console.log(chalk.green(`  ✓ Applied ${linkResult.applied} link(s)`));
    }
    legacySkippedSummary = formatSkippedLinks(linkResult.skipped, opts.verbose === true);
    if (linkResult.skipped.length > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ ${legacySkippedSummary}`,
        ),
      );
    }
    console.log(chalk.dim(`  Board: ${boardLabel}`));

    // Legacy files phase (pre-tree-import servers ONLY): sequential
    // upload for pushed tasks (idMap: cliId → saasId). The import path
    // carries files in every call (server-side skip), so this phase is
    // skipped there.
    const idMap = result.idMap ?? {};
    const taskMappings = livePushTasks
      .filter((t) => t.id && idMap[t.id])
      .map((t) => ({ localId: t.id!, remoteId: idMap[t.id!]! }));

    ({ failed: filesFailed } = await uploadPushedFiles(
      apiUrl,
      token,
      projectDir,
      taskMappings,
    ));
  } else {
    // Tree-import tallies (ticket bulk-429): links + files rode every
    // call — report them here, never in a follow-up phase.
    if ((result.linksApplied ?? 0) > 0) {
      console.log(chalk.green(`  ✓ Applied ${result.linksApplied} link(s)`));
    }
    if ((result.linksFailed ?? 0) > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ ${result.linksFailed} link(s) failed to apply`,
        ),
      );
      for (const l of result.failedLinks ?? []) {
        console.log(chalk.dim(`    - ${l.clientId}: ${l.reason}`));
      }
    }
    if ((result.filesUploaded ?? 0) > 0) {
      console.log(chalk.green(`  ✓ Uploaded ${result.filesUploaded} file(s) to storage`));
    }
    if ((result.filesSkippedPresent ?? 0) > 0) {
      console.log(
        chalk.dim(`  Skipped ${result.filesSkippedPresent} file(s) already present remotely.`),
      );
    }
    if ((result.filesFailed ?? 0) > 0) {
      console.log(
        chalk.yellow(
          `  ⚠ ${result.filesFailed} file(s) failed to upload`,
        ),
      );
      for (const f of result.failedFiles ?? []) {
        console.log(chalk.dim(`    - ${f.name}: ${f.reason}`));
      }
      filesFailed = result.filesFailed ?? 0;
    }
    console.log(chalk.dim(`  Board: ${boardLabel}`));
  }
  // Per-task atomicity report (import path only): tasks skipped WHOLE
  // before chunk one — never attempted, never marked pushed. Retryable:
  // the next run re-attempts them (also carried in --json below).
  const skippedTasks = result.skippedTasks ?? [];
  if (skippedTasks.length > 0) {
    console.log(
      chalk.yellow(
        `  ⚠ ${skippedTasks.length} task(s) skipped whole (too big for one import call — retryable, will be re-attempted next run):`,
      ),
    );
    const shown = opts.verbose === true ? skippedTasks : skippedTasks.slice(0, 5);
    for (const s of shown) {
      console.log(chalk.dim(`    - ${s.localId}: ${s.reason}`));
    }
    if (!opts.verbose && skippedTasks.length > shown.length) {
      console.log(chalk.dim(`    … and ${skippedTasks.length - shown.length} more (re-run with --verbose for the full list)`));
    }
  }
  if (filesFailed > 0) {
    // Fail LOUDLY, not silently: the local files are deleted below while the
    // remote task is missing these attachments, so exiting 0 would let
    // `push && ...` chains (and humans) believe everything synced. The names
    // above say WHAT failed; this says THAT it failed.
    process.exitCode = ExitCode.GENERAL;
  }

  // ── Local cleanup is OPT-IN ────────────────────────────────────────────
  // Push used to delete every pushed task's JSON, its files dir and its
  // screenshots by default, so the local store was consumed by a routine
  // command. Push is one-way, therefore that delete is unrecoverable by
  // push — and measured in production it deleted 2416 files, including six
  // attachments whose upload had just failed (the reference died with the
  // blob). The local store is git-tracked and is the system of record; the
  // cloud is a shared view of it. Keeping local files is now the default and
  // deletion needs an explicit `--prune-local`.
  // Pruning after a partial failure is exactly how local-only data dies: the
  // task row and its asset dir are removed while the board is missing the
  // attachments. Refuse the whole prune rather than delete per-task and hope
  // the bookkeeping is right.
  const notices: OperationNotice[] = [{ code: "PUSH_COMPLETED", message: "Push completed" }];

  // --prune-local is DESTRUCTIVE: it deletes the local task JSON and files
  // after the upload. It may only run when the server proved it mirrors the
  // whole record — on an old server (or a lossy import) the local store is the
  // only complete copy, so deleting it destroys comments, commits and links
  // that never landed. Refuse, loudly, instead of trusting "it worked".
  const pruneLocal =
    opts.pruneLocal === true && filesFailed === 0 && losslessServer;
  if (opts.pruneLocal !== true) {
    // Stryker disable once StringLiteral: display message for default keep
    console.log(chalk.dim("  Local tasks kept (push never deletes; --prune-local to opt in)."));
  } else if (filesFailed > 0) {
    console.log(
      chalk.red(`  Refusing to prune: ${filesFailed} file(s) failed to upload. Nothing was deleted locally.`),
    );
  } else if (!losslessServer) {
    console.log(
      chalk.red(
        "  Refusing to prune: this server does not mirror the whole record (lossless import), so the local",
      ),
    );
    console.log(
      chalk.dim("  task files are the only complete copy. Nothing was deleted locally."),
    );
    notices.push({
      code: "PRUNE_REFUSED_LOSSY_SERVER",
      message: "Server does not support lossless import; local tasks kept",
    });
  }
  let deleted = 0;
  let orphanDirsRemoved = 0;
  if (pruneLocal) {

    // Delete ONLY tasks this run actually pushed (created or server-matched
    // existing, per the idMap). Already-synced tasks were never touched by
    // this run; refused and atomicity-skipped tasks stay local so the next
    // run retries them — deleting them would mark an unsynced task pushed.
    const pushedIds = new Set(Object.keys(result.idMap ?? {}));
    const deletable =
      pushedIds.size > 0 ? livePushTasks.filter((t) => t.id && pushedIds.has(t.id)) : [];
    for (const task of deletable) {
      try {
        unlinkSync(task.filePath);
        deleted++;
      } catch {
        // ignore — file may have already been removed
      }
      // ── I5: Orphan cleanup — remove task asset dirs ────────────────────
      try {
        const filesDir = getFilesDir(projectDir, task.id!);
        if (existsSync(filesDir)) {
          const { rmSync } = await import("node:fs");
          rmSync(filesDir, { recursive: true, force: true });
          orphanDirsRemoved++;
        }
      } catch { /* best-effort */ }
      try {
        const screenshotsDir = join(projectDir, PROTO_DIR, SCREENSHOTS_DIR);
        const screenshotPath = join(screenshotsDir, `${task.id}.png`);
        if (existsSync(screenshotPath)) {
          unlinkSync(screenshotPath);
          orphanDirsRemoved++;
        }
      } catch { /* best-effort */ }
    }

    // Stryker disable once StringLiteral: display message for deleted files
    console.log(chalk.dim(`  Deleted ${deleted} local task file(s).`));
    if (orphanDirsRemoved > 0) {
      console.log(chalk.dim(`  Cleaned ${orphanDirsRemoved} orphaned asset dir(s).`));
    }

  }

  // Enrichment gap, report-only (the local record is the mirror source;
  // push never enriches attribution — `vibeflow authors link`
  // does that as a deliberate, reviewable edit).
  if (tasksMissingCommitAuthorEmail > 0) {
    console.log(
      chalk.yellow(
        `  ⚠ ${tasksMissingCommitAuthorEmail} task(s) have commits missing authorEmail — run \`vibeflow authors link\` to fill them in (push never enriches attribution).`,
      ),
    );
  }
  // Links accounting works on both paths: legacy fills these from the
  // links phase, import from the loop tallies.
  const linksApplied = legacyPath ? legacyLinksApplied : (result.linksApplied ?? 0);
  const linksSkippedCount = legacyPath ? legacyLinksSkipped.length : (result.linksFailed ?? 0);
  if (linksApplied > 0) {
    notices.push({ code: "LINKS_APPLIED", message: `Applied ${linksApplied} link(s)` });
  }
  if (linksSkippedCount > 0) {
    notices.push({ code: "LINKS_SKIPPED", message: legacyPath ? `Skipped ${linksSkippedCount} link(s) with unknown targets: ${legacySkippedSummary}` : `Failed to apply ${linksSkippedCount} link(s)` });
  }
  if (result.stoppedEarly !== null) {
    notices.push({
      code: result.stoppedEarly === "plan-limit" ? "PUSH_PLAN_LIMIT" : "PUSH_RATE_LIMITED",
      message: formatPushStopLine(result) ?? "Push stopped early",
    });
  }
  if (skippedTasks.length > 0) {
    notices.push({
      code: "TASKS_SKIPPED_ATOMIC",
      message: `Skipped ${skippedTasks.length} task(s) whole (retryable): ${skippedTasks.map((s) => `${s.localId}: ${s.reason}`).join("; ")}`,
    });
  }
  // --json (ticket dec52322): the FULL refusal/link detail travels here —
  // stdout stays a machine-readable envelope while the human lines above
  // stay truncated. Printed even without refusals so scripts can rely on it.
  if (opts.json === true) {
    console.log(JSON.stringify({
      imported: result.imported,
      existing: result.existing,
      skipped: result.skipped,
      attempted: result.attempted,
      total: livePushTasks.length,
      unattempted: livePushTasks.length - result.attempted,
      alreadyOnBoard: liveAlreadyOnBoard,
      failures: result.failures,
      stoppedEarly: result.stoppedEarly,
      stopMessage: result.stopMessage,
      retryAfter: result.retryAfter,
      linksApplied,
      linksSkipped: legacyPath ? legacyLinksSkipped : (result.failedLinks ?? []),
      skippedTasks,
      tasksMissingCommitAuthorEmail,
    }));
  }
  // `tasks` is the push count (ticket dec52322 reported `deleted` here, so a
  // normal push — which now never deletes — always claimed 0).
  const pushedCount = result.imported + result.existing;
  return { dryRun: false, tasks: pushedCount, files: liveFileCount, board: boardLabel, tasksMissingCommitAuthorEmail, notices };
}


/** Keep record diagnostics on every success path, including a zero-task push. */
export async function push(dir: string, opts: Parameters<typeof pushImpl>[2]): Promise<PushResult | void> {
  const reads: TaskReadFinding[] = [];
  const result = await pushImpl(dir, reads, opts);
  const notices = taskReadNotices(reads);
  if (!opts.json) for (const notice of notices) console.error(notice.message);
  if (result) result.notices.push(...notices);
  return result;
}
