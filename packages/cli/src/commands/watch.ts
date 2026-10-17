import chalk from "chalk";
import { basename, resolve, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import {
  ensureTaskDirs,
  listTasksWithPaths,
  readTaskFile,
  renderTaskForAgent,
} from "../core/tasks.js";
import { listComments } from "../core/comments.js";
import { listFiles } from "../core/files.js";
import { readConfig } from "../core/config.js";
import { getMode } from "../auth/mode.js";
import { readWorkspace } from "../auth/workspace.js";
import {
  fetchSaasTasks,
  toCliStatus,
  type SaasResult,
  type SaasTask,
} from "../saas/client.js";
import { saasFailure } from "../saas/failure.js";
import { createTaskWatcher } from "../server/watcher.js";
import { PROTO_DIR, TASKS_DIR } from "../core/types.js";
import { ExitCode } from "../core/exit-codes.js";
import {
  type TaskSnapshot,
  type WatchEvent,
  buildTaskSnapshot,
  diffTaskSnapshots,
  simpleHash,
} from "../core/watch-events.js";
import { readWatchState, writeWatchState } from "../core/watch-state.js";
import { createSink } from "../core/watch-sinks.js";

export interface WatchOptions {
  json?: boolean;
  output?: string;
  webhook?: string;
  webhookSecret?: string;
  once?: boolean;
  /** Poll period in ms (online mode only). Flag/env/default resolve it. */
  intervalMs?: number;
}

/** Env fallback for --webhook-secret (resolved in watch(), not in the sink). */
export const WEBHOOK_SECRET_ENV_VAR = "VIBEFLOW_WEBHOOK_SECRET";

/**
 * Classifies a task update into an "important" event or nothing.
 *
 * - `"new"`          — the task did not exist in the previous snapshot.
 * - `"moved-to-todo"` — the task existed before and transitioned into `todo`
 *                       from any other status (i.e. it just became actionable).
 * - `null`           — not an important update (e.g. title/description edits,
 *                       or transitions between other statuses).
 */
export function classifyTaskUpdate(
  prevStatus: string | undefined,
  newStatus: string,
): "new" | "moved-to-todo" | null {
  if (prevStatus === undefined) return "new";
  if (prevStatus !== "todo" && newStatus === "todo") return "moved-to-todo";
  return null;
}

/** Renders full ticket details for a task, in the same format as `tasks --get`. */
function renderTicket(projectDir: string, taskId: string): string | null {
  try {
    const task = listTasksWithPaths(projectDir).find((t) => t.id === taskId);
    if (!task) return null;
    const config = readConfig(projectDir);
    const comments = listComments(projectDir, taskId);
    const files = listFiles(projectDir, taskId).map((f) => ({
      ...f,
      url: `http://localhost:${config.port}${f.url}`,
    }));
    const allTasks = listTasksWithPaths(projectDir).map(
      (t) => ({ ...t }) as import("../core/types").Task,
    );
    return renderTaskForAgent(
      task,
      task.filePath,
      comments,
      files,
      projectDir,
      allTasks,
    );
  } catch {
    return null;
  }
}

/** Build a full snapshot of all tasks at the current moment. */
function buildAllSnapshots(
  projectDir: string,
  now: string,
): Map<string, TaskSnapshot> {
  const snapshots = new Map<string, TaskSnapshot>();
  for (const task of listTasksWithPaths(projectDir)) {
    try {
      const comments = listComments(projectDir, task.id);
      const files = listFiles(projectDir, task.id);
      const lastCommentAt =
        comments.length > 0
          ? comments[comments.length - 1].createdAt
          : undefined;
      snapshots.set(
        task.id,
        buildTaskSnapshot(
          task,
          comments.length,
          lastCommentAt,
          files.length,
          now,
        ),
      );
    } catch {
      // Skip tasks that fail to snapshot
    }
  }
  return snapshots;
}

/**
 * Shared announcement printer: the single visual dialect for "important"
 * watch events. Both local (fs watcher) and online (poll) paths funnel
 * through here so the two modes cannot drift into different formats —
 * only the `details` body differs (full local ticket vs. online summary).
 */
export function printTaskAnnouncement(
  kind: "new" | "moved-to-todo",
  details: string,
): void {
  console.log();
  if (kind === "new") {
    console.log(chalk.green.bold("🆕 NEW TASK"));
  } else {
    console.log(chalk.blue.bold("▶ MOVED TO TODO"));
  }
  console.log(chalk.dim("─".repeat(62)));
  for (const line of details.split("\n")) {
    console.log(chalk.dim(line));
  }
  console.log(chalk.dim("─".repeat(62)));
}

/**
 * Shared emit-and-announce step: every event goes to the sink, and
 * new/moved-to-todo events also print the ticket (unless --json, where
 * stdout is reserved for JSONL). Used by the local daemon and the online
 * poll tick alike.
 */
function dispatchWatchEvents(
  sink: ReturnType<typeof createSink>,
  events: WatchEvent[],
  opts: WatchOptions,
  detailsFor: (taskId: string) => string | null,
): void {
  for (const event of events) {
    sink.emit(event);
    if (
      !opts.json &&
      (event.type === "new" || event.type === "moved-to-todo")
    ) {
      try {
        const details = detailsFor(event.taskId);
        if (details) printTaskAnnouncement(event.type, details);
      } catch (err) {
        console.error(
          chalk.red(`  Error rendering task ${event.taskId}:`),
          err,
        );
      }
    }
  }
}

/** Daemon mode: watch for changes and emit events as they happen. */
function watchDaemon(projectDir: string, opts: WatchOptions): void {
  const tasksDir = join(projectDir, PROTO_DIR, TASKS_DIR);
  const sink = createSink(opts);

  // Baseline snapshots
  const now = new Date().toISOString();
  const snapshots = buildAllSnapshots(projectDir, now);

  const detailsFor = (taskId: string): string | null =>
    renderTicket(projectDir, taskId);

  const watcher = createTaskWatcher(tasksDir, {
    onChanged: (filePath) => {
      try {
        const task = readTaskFile(filePath);
        if (!task) return;
        const prev = snapshots.get(task.id);
        const ts = new Date().toISOString();

        // Rebuild snapshot for this task
        const comments = listComments(projectDir, task.id);
        const files = listFiles(projectDir, task.id);
        const lastCommentAt =
          comments.length > 0
            ? comments[comments.length - 1].createdAt
            : undefined;
        const next = buildTaskSnapshot(
          task,
          comments.length,
          lastCommentAt,
          files.length,
          ts,
        );

        // Emit events (sink always; ticket banner for new/moved-to-todo).
        const events = diffTaskSnapshots(task, prev, next);
        snapshots.set(task.id, next);
        dispatchWatchEvents(sink, events, opts, detailsFor);
      } catch (err) {
        console.error(
          chalk.red(`  Error processing ${basename(filePath)}:`),
          err,
        );
      }
    },
    onDeleted: (filePath) => {
      snapshots.delete(basename(filePath, ".json"));
    },
  });

  watcher.on("error", (err) => {
    console.error(chalk.red("  Watcher error:"), err);
  });

  console.log();
  console.log(chalk.bold("  Vibeflow — watching for task updates"));
  console.log(chalk.dim(`  ${tasksDir}`));
  console.log(chalk.dim("  Notifies on: new tasks, tasks moved to todo."));
  console.log(chalk.dim("  Press Ctrl+C to stop."));
  console.log();

  process.once("SIGINT", () => {
    void watcher.close().then(
      () => {
        sink.close?.();
        console.log(chalk.dim("\n  Watch stopped."));
        process.exit(0);
      },
      () => {
        sink.close?.();
        process.exit(0);
      },
    );
  });
  process.once("SIGTERM", () => {
    void watcher.close().then(
      () => {
        sink.close?.();
        process.exit(0);
      },
      () => {
        sink.close?.();
        process.exit(0);
      },
    );
  });
}

/** --once mode: one-shot poll, diff against state, emit events, exit. */
function watchOnce(projectDir: string, opts: WatchOptions): void {
  const sink = createSink(opts);
  const now = new Date().toISOString();

  // Build current snapshots of all tasks
  const currentSnapshots = buildAllSnapshots(projectDir, now);

  // Read existing state: previousSnapshots holds the last-known snapshot per task
  const state = readWatchState(projectDir);
  const prevSnapshots: Map<string, TaskSnapshot> = new Map(
    Object.entries(state.previousSnapshots ?? {}),
  );

  // Emit events for all tasks by diffing current against previous
  for (const [taskId, snapshot] of currentSnapshots) {
    const task = listTasksWithPaths(projectDir).find((t) => t.id === taskId);
    if (!task) continue;

    const prev = prevSnapshots.get(taskId);

    // "new" event: task has no previous snapshot
    if (prev === undefined) {
      sink.emit({ type: "new", taskId: task.id, timestamp: snapshot.takenAt });
      continue;
    }

    // Diff: detect status changes, moved-to-todo, comments, files, etc.
    const events = diffTaskSnapshots(task, prev, snapshot);
    for (const event of events) {
      sink.emit(event);
    }
  }

  // Persist current snapshots as the new "previous" state for next run
  const nextPrevSnapshots: Record<string, TaskSnapshot> = {};
  for (const [taskId, snapshot] of currentSnapshots) {
    nextPrevSnapshots[taskId] = snapshot;
  }
  state.previousSnapshots = nextPrevSnapshots;
  writeWatchState(projectDir, state);

  sink.close?.();
  process.exit(0);
}

// ── Online (SaaS/PAT) mode: poll, do not socket ───────────────────────────
//
// Decision record (ticket 1139b56a, worker 2026-10-17):
// - WHAT: poll `fetchSaasTasks(boardId, { hydrate: false })` on a fixed
//   interval (default 15 s, floor 5 s, flag/env configurable, backoff on
//   error) instead of adding a socket.io client.
// - WHY: the realtime server speaks socket.io but the CLI only carries
//   `ws`. Each poll costs 1-2 cheap list reads (~15 ms wire) against the
//   v0 items' own commentCount/fileCount — hydration (2 requests per task
//   plus text downloads) is skipped so cost does not scale with board
//   size. 15 s keeps a typical board at ~4-8 reads/min, far under the
//   300 reads/min/token quota, while still feeling live; 5 s or faster
//   would burn quota and hammer the 1 vCPU box for no perceptible gain.
// - IMPACT: online `vibeflow watch` actually watches (previously a silent
//   no-op); auth failures exit non-zero instead of watching nothing.

/** Default online poll period: see the decision record above. */
export const DEFAULT_ONLINE_POLL_MS = 15_000;
/** Fastest allowed poll: below this the CLI would hammer the 1 vCPU box. */
export const MIN_ONLINE_POLL_MS = 5_000;
/** Backoff ceiling for consecutive failed polls. */
export const MAX_ONLINE_POLL_BACKOFF_MS = 120_000;
/** Env override for the online poll period (milliseconds). */
export const WATCH_INTERVAL_ENV_VAR = "VIBEFLOW_WATCH_INTERVAL_MS";

/**
 * Resolve the online poll period: explicit flag wins, then the env var,
 * then the default. Always floored at MIN_ONLINE_POLL_MS so neither a
 * flag nor the env can turn the CLI into a hammer.
 */
export function resolveOnlinePollMs(explicitMs?: number): number {
  const envRaw = process.env[WATCH_INTERVAL_ENV_VAR];
  const envMs = envRaw !== undefined && envRaw !== "" ? Number(envRaw) : NaN;
  const chosen =
    explicitMs ??
    (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_ONLINE_POLL_MS);
  return Math.max(MIN_ONLINE_POLL_MS, Math.floor(chosen));
}

/** Backoff for consecutive failed polls: double per failure, capped. */
export function computeOnlineRetryDelayMs(
  intervalMs: number,
  consecutiveFailures: number,
): number {
  return Math.min(
    intervalMs * 2 ** Math.max(0, consecutiveFailures),
    MAX_ONLINE_POLL_BACKOFF_MS,
  );
}

/**
 * True when an online fetch error means "re-login" (expired, revoked or
 * wrong-scope PAT) rather than "retry later". Mirrors saasFailure(): the
 * client reports a missing token as NOT_AUTHENTICATED and a rejected one
 * as HTTP_ERROR with status 401/403.
 */
export function isOnlineAuthFailure(error: {
  code: string;
  status?: number;
}): boolean {
  if (error.code === "NOT_AUTHENTICATED") return true;
  return error.status === 401 || error.status === 403;
}

/** Build watch snapshots from SaaS tasks (no hydration needed). */
export function buildOnlineSnapshots(
  tasks: SaasTask[],
  now: string,
): Map<string, TaskSnapshot> {
  const snapshots = new Map<string, TaskSnapshot>();
  for (const task of tasks) {
    // v0 list items carry counts; legacy/inlined shapes carry arrays.
    // Prefer the counts so unhydrated polls still diff correctly.
    const commentCount =
      typeof task.commentCount === "number"
        ? task.commentCount
        : (task.comments?.length ?? 0);
    const fileCount =
      typeof task.fileCount === "number"
        ? task.fileCount
        : (task.files?.length ?? 0);
    const comments = task.comments ?? [];
    const lastCommentAt =
      comments.length > 0 ? comments[comments.length - 1].createdAt : undefined;
    snapshots.set(task.id, {
      taskId: task.id,
      status: toCliStatus(task.status) as TaskSnapshot["status"],
      priority: task.priority ?? undefined,
      descriptionHash: simpleHash(task.description ?? ""),
      commentCount,
      lastCommentAt,
      fileCount,
      takenAt: now,
    });
  }
  return snapshots;
}

/**
 * Diff current online snapshots against the previous ones, emitting the
 * same WatchEvent dialect the local watcher produces. diffTaskSnapshots
 * is the shared engine (`prev === undefined` already means "new"); it
 * only reads task.id, so an id stub stands in for the local Task.
 */
export function diffOnlineSnapshots(
  current: Map<string, TaskSnapshot>,
  prev: Map<string, TaskSnapshot>,
): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const [taskId, next] of current) {
    events.push(
      ...diffTaskSnapshots({ id: taskId } as never, prev.get(taskId), next),
    );
  }
  return events;
}

/** One-line-per-field online ticket summary for the shared banner. */
export function renderOnlineTicket(task: SaasTask): string {
  const lines = [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${toCliStatus(task.status)}`,
  ];
  if (task.priority) lines.push(`Priority: ${task.priority}`);
  if (task.type) lines.push(`Type: ${task.type}`);
  if (task.description) {
    const oneLine = task.description.replace(/\s+/g, " ").trim();
    lines.push(
      `Description: ${oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine}`,
    );
  }
  const commentCount = task.commentCount ?? task.comments?.length ?? 0;
  const fileCount = task.fileCount ?? task.files?.length ?? 0;
  lines.push(`Comments: ${commentCount}  Files: ${fileCount}`);
  return lines.join("\n");
}

export type OnlineFetch = () => Promise<
  SaasResult<{ tasks: SaasTask[]; boardId: string }>
>;

export interface OnlinePollOutcome {
  snapshots: Map<string, TaskSnapshot>;
  /** Raw tasks behind the snapshots (for ticket banners). */
  tasks: SaasTask[];
  events: WatchEvent[];
  /** "auth" = stop loudly; "error" = back off and retry. Absent = ok. */
  failure?: "auth" | "error";
  message?: string;
}

/**
 * One online poll tick: fetch, snapshot, diff. Pure except for the
 * injected fetch — the daemon loop and --once both funnel through here
 * so the poll/diff/auth logic is unit-testable without timers.
 */
export async function runOnlinePoll(
  fetchTasks: OnlineFetch,
  prev: Map<string, TaskSnapshot>,
  now: string,
): Promise<OnlinePollOutcome> {
  let result: SaasResult<{ tasks: SaasTask[]; boardId: string }>;
  try {
    result = await fetchTasks();
  } catch (err) {
    return {
      snapshots: prev,
      tasks: [],
      events: [],
      failure: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!result.ok) {
    return {
      snapshots: prev,
      tasks: [],
      events: [],
      failure: isOnlineAuthFailure(result.error) ? "auth" : "error",
      message: result.error.message,
    };
  }
  const snapshots = buildOnlineSnapshots(result.data.tasks, now);
  return {
    snapshots,
    tasks: result.data.tasks,
    events: diffOnlineSnapshots(snapshots, prev),
  };
}

/** Loud auth failure: never a silent watch that reports nothing. */
function reportOnlineAuthFailure(message?: string): void {
  const extra = saasFailure({ code: "HTTP_ERROR", status: 401 });
  console.error(chalk.red("  \u2717 Online watch: authentication failed."));
  if (message) console.error(chalk.dim(`  Server said: ${message}`));
  console.error(
    chalk.yellow(
      `  Your token is expired, revoked, or lacks the tasks scope. ${extra.suggestion ?? "Run 'vibeflow login' and retry."}`,
    ),
  );
  process.exitCode = ExitCode.AUTH;
}

/** --once in online mode: single poll, diff against state, emit, exit. */
async function watchOnlineOnce(
  projectDir: string,
  opts: WatchOptions,
): Promise<void> {
  const sink = createSink(opts);
  const workspace = await readWorkspace();
  const now = new Date().toISOString();
  const outcome = await runOnlinePoll(
    () => fetchSaasTasks(workspace?.id, { hydrate: false }),
    new Map(),
    now,
  );
  if (outcome.failure === "auth") {
    reportOnlineAuthFailure(outcome.message);
    sink.close?.();
    return;
  }
  if (outcome.failure === "error") {
    console.error(
      chalk.red(`  \u2717 Online watch: poll failed: ${outcome.message ?? "unknown error"}`),
    );
    console.error(
      chalk.dim("  Check your connection or run 'vibeflow auth login' if your session expired."),
    );
    process.exitCode = ExitCode.GENERAL;
    sink.close?.();
    return;
  }

  // Same shape as the local --once: diff current against the stored
  // previous snapshots, emit, then persist current as the new previous.
  const state = readWatchState(projectDir);
  const prevSnapshots: Map<string, TaskSnapshot> = new Map(
    Object.entries(state.previousSnapshots ?? {}),
  );
  const events = diffOnlineSnapshots(outcome.snapshots, prevSnapshots);
  for (const event of events) {
    sink.emit(event);
  }

  const nextPrevSnapshots: Record<string, TaskSnapshot> = {};
  for (const [taskId, snapshot] of outcome.snapshots) {
    nextPrevSnapshots[taskId] = snapshot;
  }
  state.previousSnapshots = nextPrevSnapshots;
  writeWatchState(projectDir, state);

  sink.close?.();
  process.exit(0);
}

/**
 * Online daemon: poll on a setTimeout chain (variable delay for backoff),
 * baseline silently on the first poll like the local daemon does.
 * Returns a stop function; SIGINT/SIGTERM stop cleanly (no dangling timer).
 */
export async function startOnlineWatch(
  projectDir: string,
  opts: WatchOptions,
  overrides?: { fetchTasks?: OnlineFetch; now?: () => string },
): Promise<{ stop: () => void }> {
  const sink = createSink(opts);
  const intervalMs = resolveOnlinePollMs(opts.intervalMs);
  const now = overrides?.now ?? (() => new Date().toISOString());
  const workspace = overrides?.fetchTasks
    ? undefined
    : await readWorkspace();
  const fetchTasks: OnlineFetch =
    overrides?.fetchTasks ??
    (() => fetchSaasTasks(workspace?.id, { hydrate: false }));

  // The first poll must succeed — otherwise the watch could not start and
  // exiting non-zero (loudly) beats watching nothing (silently).
  const baseline = await runOnlinePoll(fetchTasks, new Map(), now());
  if (baseline.failure === "auth") {
    reportOnlineAuthFailure(baseline.message);
    sink.close?.();
    throw new Error("Online watch could not start: authentication failed.");
  }
  if (baseline.failure === "error") {
    console.error(
      chalk.red(`  \u2717 Online watch: initial poll failed: ${baseline.message ?? "unknown error"}`),
    );
    process.exitCode = ExitCode.GENERAL;
    sink.close?.();
    throw new Error("Online watch could not start: initial poll failed.");
  }
  let snapshots = baseline.snapshots;
  // Fresh baselines diff as all-"new" against an empty prev; like the
  // local daemon, swallow that first flood — only later polls emit.
  // `projectDir` is kept for signature symmetry with the local daemon.
  void projectDir;
  let tasksById = new Map(baseline.tasks.map((t) => [t.id, t] as const));

  let consecutiveFailures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const outcome = await runOnlinePoll(fetchTasks, snapshots, now());
    if (stopped) return;
    if (outcome.failure === "auth") {
      reportOnlineAuthFailure(outcome.message);
      stop();
      return;
    }
    if (outcome.failure === "error") {
      consecutiveFailures += 1;
      const delay = computeOnlineRetryDelayMs(
        intervalMs,
        consecutiveFailures,
      );
      if (!opts.json) {
        console.error(
          chalk.yellow(
            `  \u26a0 Online poll failed (${outcome.message ?? "unknown error"}); retrying in ${Math.round(delay / 1000)}s.`,
          ),
        );
      }
      timer = setTimeout(tick, delay);
      return;
    }
    consecutiveFailures = 0;
    snapshots = outcome.snapshots;
    tasksById = new Map(outcome.tasks.map((t) => [t.id, t] as const));
    if (outcome.events.length === 0) {
      if (!opts.json) {
        const at = new Date().toLocaleTimeString();
        console.log(
          chalk.dim(
            `  \u25cb watching online (${snapshots.size} tasks, checked ${at}, every ${Math.round(intervalMs / 1000)}s)`,
          ),
        );
      }
    } else {
      dispatchWatchEvents(sink, outcome.events, opts, (taskId) => {
        const task = tasksById.get(taskId);
        return task ? renderOnlineTicket(task) : null;
      });
    }
    timer = setTimeout(tick, intervalMs);
  };

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    sink.close?.();
  };
  const onSigint = (): void => {
    stop();
    console.log(chalk.dim("\n  Watch stopped."));
    process.exit(0);
  };
  const onSigterm = (): void => {
    stop();
    process.exit(0);
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  if (!opts.json) {
    console.log();
    console.log(chalk.bold("  Vibeflow \u2014 watching for task updates (online)"));
    console.log(
      chalk.dim(
        `  Polling every ${Math.round(intervalMs / 1000)}s. Notifies on: new tasks, tasks moved to todo.`,
      ),
    );
    console.log(chalk.dim("  Press Ctrl+C to stop."));
    console.log();
  }
  timer = setTimeout(tick, intervalMs);
  return { stop };
}

/**
 * Watches for task updates — local task store or online board.
 *
 * LOCAL (no token): fs watcher daemon, or one-shot diff with --once.
 * ONLINE (token present): poll the SaaS board (daemon or --once). This
 * mode branch is the whole of ticket 1139b56a: without it, online
 * `vibeflow watch` was a silent no-op that appeared to succeed while
 * watching nothing.
 *
 * Default (daemon): runs until interrupted, notifies on new/moved-to-todo.
 * --once: one-shot poll, diff against state, emit events, exit.
 *
 * Output modes:
 * --json       emit JSONL to stdout
 * --output <f> append JSONL to file
 * --webhook <u> POST each event to URL
 * --webhook-secret <s> (or VIBEFLOW_WEBHOOK_SECRET) sign webhook deliveries
 * --interval <s> online poll period in seconds (default 15, min 5)
 */
export async function watch(
  dir: string,
  opts: WatchOptions = {},
): Promise<void> {
  const projectDir = resolve(dir);

  if (opts.webhook && !opts.webhookSecret) {
    opts.webhookSecret = process.env[WEBHOOK_SECRET_ENV_VAR];
  }

  if (!existsSync(projectDir)) {
    console.error(
      chalk.red(`  Error: directory does not exist: ${projectDir}`),
    );
    process.exitCode = ExitCode.USAGE;
    return;
  }
  if (!statSync(projectDir).isDirectory()) {
    console.error(chalk.red(`  Error: not a directory: ${projectDir}`));
    process.exitCode = ExitCode.USAGE;
    return;
  }

  // Online mode must actually watch something: branch BEFORE the local
  // fs watcher, which would otherwise watch local files that the online
  // board never touches (the historical silent no-op).
  if ((await getMode()) === "saas") {
    if (opts.once) {
      await watchOnlineOnce(projectDir, opts);
    } else {
      // Throws (after setting a non-zero exit) when the watch could
      // not start — a loud failure, never a silent no-op.
      await startOnlineWatch(projectDir, opts);
    }
    return;
  }

  ensureTaskDirs(projectDir);

  if (opts.once) {
    watchOnce(projectDir, opts);
  } else {
    watchDaemon(projectDir, opts);
  }
}
