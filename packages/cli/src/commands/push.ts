import chalk from "chalk";
import { unlinkSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { listTasksWithPaths } from "../core/tasks.js";
import { listFiles, getFilesDir } from "../core/files.js";
import { readToken } from "../auth/token.js";
import { readWorkspace } from "../auth/workspace.js";
import { applyPushLinks, createTasksOneByOne, formatPushRefusalSummary, formatPushStopLine, formatSkippedLinks, login, createTaskPushProgressReporter, PUSH_429_MAX_RESUMES, type PushLoopResult } from "../auth/login.js";
import { probeImportCapability, evaluateBatchPreflight, importBatchTree, readBatchCheckpoint, topoOrderImportTasks, fetchOnlineTaskIds, type ImportTaskInput } from "../saas/batch-push.js";
import { PROTO_DIR, SCREENSHOTS_DIR } from "../core/types.js";
import { ExitCode } from "../core/exit-codes.js";
import type { OperationNotice } from "../core/operations.js";
import { maybeCompressForUpload } from "../saas/compression.js";
import { getApiUrl, surfacePath } from "../core/api-url.js";

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
      const absPath = f.linkedPath ?? join(getFilesDir(projectDir, localId), f.name);
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
      record: t as unknown as Record<string, unknown>,
      files: listFiles(projectDir, t.id)
        .filter((f) => {
          const absPath = f.linkedPath ?? join(getFilesDir(projectDir, t.id), f.name);
          return existsSync(absPath);
        })
        .map((f) => ({
          name: f.name,
          filePath: f.linkedPath ?? join(getFilesDir(projectDir, t.id), f.name),
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
   * Named `notices`, not `steps`: this object was the push_tasks wire payload
   * (the MCP tool is now removed; the hidden CLI push still returns it), so
   * a `steps` key here would be the one place the push surface still used
   * the old name, and its values were bare strings. Same `{code, message}`
   * objects the CLI emits.
   */
  notices: OperationNotice[];
}

export async function push(dir: string, opts: { workspace?: string; keepLocalFiles?: boolean; dryRun?: boolean; verbose?: boolean; json?: boolean }): Promise<PushResult | void> {
  const projectDir = resolve(dir);

  const taskList = listTasksWithPaths(projectDir);
  if (taskList.length === 0) {
    // Stryker disable once StringLiteral: display message for no tasks
    console.log(chalk.dim("  No local tasks found. Nothing to push."));
    return {
      dryRun: !!opts.dryRun,
      tasks: 0,
      files: 0,
      notices: [
        { code: "NOTHING_TO_PUSH", message: "No local tasks found" },
      ],
    };
  }

  let workspaceId = opts.workspace;
  if (!workspaceId) {
    const saved = await readWorkspace().catch(() => null);
    if (saved) workspaceId = saved.id;
  }
  const boardLabel = workspaceId ? ((await readWorkspace().catch(() => null))?.name ?? workspaceId) : "(no board selected)";

  const apiUrl = getApiUrl();

  // ── Diff-based push: fetch online ids FIRST, push ONLY the unsynced ──
  // A re-push with nothing new is a no-op (no probe, no creates, no
  // deletions) — safe to run any time. `onlineIds === null` means the
  // diff is unknown (no token/board, or the listing failed): every local
  // task is attempted and the summary is the source of truth, said out loud.
  const earlyToken = await readToken();
  let onlineIds: Set<string> | null = null;
  let boardListed = false;
  let boardListFailed = false;
  if (earlyToken && workspaceId) {
    try {
      onlineIds = await fetchOnlineTaskIds(apiUrl, earlyToken, workspaceId);
      boardListed = true;
    } catch {
      boardListFailed = true;
    }
  }
  const listedIds: Set<string> | null = onlineIds;
  const pushTasks =
    listedIds !== null ? taskList.filter((t) => !listedIds.has(t.id!)) : taskList;
  const alreadyOnBoard = taskList.length - pushTasks.length;

  // File-gap honesty: push syncs files ONLY with their task's creation —
  // files of already-synced tasks are never re-checked. Count them locally
  // so the empty-diff lines below cannot read as "all files verified".
  const countLocalFiles = (tasks: typeof taskList): number => {
    let n = 0;
    for (const t of tasks) {
      try {
        n += listFiles(projectDir, t.id!).length;
      } catch {
        /* best-effort preview count */
      }
    }
    return n;
  };
  const reportUnverifiedFiles = (tasks: typeof taskList): void => {
    const n = countLocalFiles(tasks);
    if (n > 0) {
      console.log(chalk.dim(`  (${n} local file(s) on already-pushed tasks were not re-checked — files sync with their task's creation.)`));
    }
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
    if (onlineIds !== null) {
      if (pushTasks.length === 0) {
        console.log(chalk.green(`  Everything is already pushed (${taskList.length} tasks on the board).`));
        reportUnverifiedFiles(taskList);
        return {
          dryRun: true,
          tasks: 0,
          files: 0,
          board: boardLabel,
          notices: [{ code: "ALREADY_PUSHED", message: "Everything is already pushed" }],
        };
      }
      // Stryker disable once StringLiteral: display message for dry-run
      console.log(chalk.cyan(`  Dry run: ${pushTasks.length} task(s) to push (${alreadyOnBoard} already on the board), ${fileCount} file(s), board: ${boardLabel}`));
      return {
        dryRun: true,
        tasks: pushTasks.length,
        files: fileCount,
        board: boardLabel,
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
      onlineIds = await fetchOnlineTaskIds(apiUrl, token, workspaceId);
      boardListed = true;
      boardListFailed = false;
    } catch {
      boardListFailed = true;
    }
  }
  const liveListedIds: Set<string> | null = onlineIds;
  const livePushTasks =
    liveListedIds !== null ? taskList.filter((t) => !liveListedIds.has(t.id!)) : taskList;
  const liveAlreadyOnBoard = taskList.length - livePushTasks.length;
  let liveFileCount = fileCount;
  if (livePushTasks.length !== pushTasks.length) {
    liveFileCount = 0;
    for (const task of livePushTasks) {
      liveFileCount += listFiles(projectDir, task.id!).length;
    }
  }
  if (onlineIds !== null && livePushTasks.length === 0) {
    console.log(chalk.green(`  Everything is already pushed (${taskList.length} tasks on the board).`));
    reportUnverifiedFiles(taskList);
    return {
      dryRun: false,
      tasks: 0,
      files: 0,
      board: boardLabel,
      notices: [{ code: "ALREADY_PUSHED", message: "Everything is already pushed" }],
    };
  }
  if (onlineIds !== null) {
    // Stryker disable once StringLiteral: display message for task count
    console.log(chalk.cyan(`  ${livePushTasks.length} task(s) to push (${liveAlreadyOnBoard} already on the board). Pushing online...`));
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
    const probe = await probeImportCapability(apiUrl, token);
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
      const refusal = evaluateBatchPreflight(
        inputs.length - resumed,
        probe.preflight,
      );
      if (refusal !== null) {
        console.error(chalk.red(`  ${refusal}`));
        process.exitCode = ExitCode.GENERAL;
        return;
      }
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
  // SAFETY: listTasksWithPaths returns parsed task JSON objects plus a
  // filePath string — each entry spreads as a plain record, so the cast is
  // representation-preserving (same invariant as the phase-1 loop above).
  let filesFailed = 0;
  let legacyLinksApplied = 0;
  let legacyLinksSkipped: Array<{ from: string; to: string; type: string; reason: string }> = [];
  let legacySkippedSummary = "";
  if (legacyPath) {
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

  if (opts.keepLocalFiles) {
    // Stryker disable once StringLiteral: display message for keep local files
    console.log(chalk.dim("  Local task files kept (--keep-local-files)."));
    return;
  }

  // Delete ONLY tasks this run actually pushed (created or server-matched
  // existing, per the idMap). Already-synced tasks were never touched by
  // this run; refused and atomicity-skipped tasks stay local so the next
  // run retries them — deleting them would mark an unsynced task pushed.
  const pushedIds = new Set(Object.keys(result.idMap ?? {}));
  const deletable =
    pushedIds.size > 0 ? livePushTasks.filter((t) => t.id && pushedIds.has(t.id)) : [];
  let deleted = 0;
  let orphanDirsRemoved = 0;
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

  const notices: OperationNotice[] = [{ code: "PUSH_COMPLETED", message: "Push completed" }];
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
    }));
  }
  return { dryRun: false, tasks: deleted, files: liveFileCount, board: boardLabel, notices };
}

