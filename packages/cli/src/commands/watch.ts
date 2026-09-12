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
import { createTaskWatcher } from "../server/watcher.js";
import { PROTO_DIR, TASKS_DIR } from "../core/types.js";
import { ExitCode } from "../core/exit-codes.js";
import {
  type TaskSnapshot,
  buildTaskSnapshot,
  diffTaskSnapshots,
} from "../core/watch-events.js";
import { readWatchState, writeWatchState } from "../core/watch-state.js";
import { createSink } from "../core/watch-sinks.js";

export interface WatchOptions {
  json?: boolean;
  output?: string;
  webhook?: string;
  once?: boolean;
}

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

/** Daemon mode: watch for changes and emit events as they happen. */
function watchDaemon(projectDir: string, opts: WatchOptions): void {
  const tasksDir = join(projectDir, PROTO_DIR, TASKS_DIR);
  const sink = createSink(opts);

  // Baseline snapshots
  const now = new Date().toISOString();
  const snapshots = buildAllSnapshots(projectDir, now);

  const announce = (kind: "new" | "moved-to-todo", taskId: string): void => {
    try {
      const details = renderTicket(projectDir, taskId);
      if (!details) return;
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
    } catch (err) {
      console.error(chalk.red(`  Error rendering task ${taskId}:`), err);
    }
  };

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

        // Emit events
        const events = diffTaskSnapshots(task, prev, next);
        snapshots.set(task.id, next);

        for (const event of events) {
          sink.emit(event);
          if (
            !opts.json &&
            (event.type === "new" || event.type === "moved-to-todo")
          ) {
            announce(event.type, event.taskId);
          }
        }
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

/**
 * Watches the local task store for important updates.
 *
 * Default (daemon): runs until interrupted, notifies on new/moved-to-todo.
 * --once: one-shot poll, diff against state, emit events, exit.
 *
 * Output modes:
 * --json       emit JSONL to stdout
 * --output <f> append JSONL to file
 * --webhook <u> POST each event to URL
 */
export function watch(dir: string, opts: WatchOptions = {}): void {
  const projectDir = resolve(dir);

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

  ensureTaskDirs(projectDir);

  if (opts.once) {
    watchOnce(projectDir, opts);
  } else {
    watchDaemon(projectDir, opts);
  }
}
