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
    return renderTaskForAgent(task, task.filePath, comments, files, projectDir);
  } catch {
    return null;
  }
}

/**
 * Watches the local task store for important updates and prints the full ticket
 * details whenever a task is newly created or moved back to `todo`.
 * Runs until the process is interrupted (Ctrl+C).
 */
export function watch(dir: string): void {
  const projectDir = resolve(dir);

  // Validate the directory exists and is actually a directory.
  if (!existsSync(projectDir)) {
    console.error(chalk.red(`  Error: directory does not exist: ${projectDir}`));
    process.exitCode = ExitCode.USAGE;
    return;
  }
  if (!statSync(projectDir).isDirectory()) {
    console.error(chalk.red(`  Error: not a directory: ${projectDir}`));
    process.exitCode = ExitCode.USAGE;
    return;
  }

  // Ensure the task store exists before watching — chokidar does not detect
  // creation of a previously non-existent watch root.
  ensureTaskDirs(projectDir);
  const tasksDir = join(projectDir, PROTO_DIR, TASKS_DIR);

  // Baseline snapshot of statuses, used to distinguish "new" from "status change".
  const statusById = new Map<string, string>();
  for (const task of listTasksWithPaths(projectDir)) {
    statusById.set(task.id, task.status);
  }

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
        const prev = statusById.get(task.id);
        const kind = classifyTaskUpdate(prev, task.status);
        statusById.set(task.id, task.status);
        if (kind) announce(kind, task.id);
      } catch (err) {
        console.error(chalk.red(`  Error processing ${basename(filePath)}:`), err);
      }
    },
    onDeleted: (filePath) => {
      statusById.delete(basename(filePath, ".json"));
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

  // chokidar keeps the event loop alive; close cleanly on interrupt.
  process.once("SIGINT", () => {
    void watcher.close().then(
      () => {
        console.log(chalk.dim("\n  Watch stopped."));
        process.exit(0);
      },
      () => process.exit(0),
    );
  });
  process.once("SIGTERM", () => {
    void watcher.close().then(() => process.exit(0), () => process.exit(0));
  });
}
