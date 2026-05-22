import chalk from "chalk";
import { unlinkSync, readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { listTasksWithPaths } from "../core/tasks.js";
import { listFiles, getFilesDir } from "../core/files.js";
import { readToken } from "../auth/token.js";
import { readWorkspace } from "../auth/workspace.js";
import { login } from "../auth/login.js";
import { PROTO_DIR, FILES_DIR } from "../core/types.js";

// Stryker disable once StringLiteral: default API URL is a configuration constant
const DEFAULT_API_URL = "https://app.vibeflow.tools";

function getApiUrl(): string {
  return process.env.VIBEFLOW_API_URL ?? DEFAULT_API_URL;
}

type ImportResult = {
  imported: number;
  skipped?: number;
  ids: string[];
  workspaceId: string;
  boardId: string;
  /** Map of cliTaskId → saasTaskId returned by the server */
  idMap?: Record<string, string>;
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

async function uploadTaskFiles(
  apiUrl: string,
  token: string,
  projectDir: string,
  taskMappings: Array<{ localId: string; remoteId: string }>,
): Promise<{ uploaded: number; failed: number; failedFiles: Array<{ name: string; reason: string }> }> {
  const allJobs: Array<{ remoteId: string; name: string; filePath: string; size: number }> = [];

  for (const { localId, remoteId } of taskMappings) {
    const files = listFiles(projectDir, localId);
    for (const f of files) {
      const absPath = f.linkedPath ?? join(getFilesDir(projectDir, localId), f.name);
      if (existsSync(absPath)) {
        allJobs.push({ remoteId, name: f.name, filePath: absPath, size: f.size });
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
      const res = await fetch(
        `${apiUrl}/api/tasks/${encodeURIComponent(job.remoteId)}/files`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "x-filename": encodeURIComponent(job.name),
          },
          body: data,
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

export async function push(dir: string, opts: { workspace?: string; keepLocalFiles?: boolean }): Promise<void> {
  const projectDir = resolve(dir);

  let token = await readToken();
  if (!token) {
    // Stryker disable once StringLiteral: display message for login flow
    console.log(chalk.yellow("  Not logged in. Starting login flow..."));
    await login();
    token = await readToken();
    if (!token) {
      // Stryker disable once StringLiteral: display message for login failure
      console.error(chalk.red("  Login failed. Please run `vibeflow login` and try again."));
      process.exitCode = 1;
      return;
    }
  }

  const taskList = listTasksWithPaths(projectDir);
  if (taskList.length === 0) {
    // Stryker disable once StringLiteral: display message for no tasks
    console.log(chalk.dim("  No local tasks found. Nothing to push."));
    return;
  }

  // Stryker disable once StringLiteral: display message for task count
  console.log(chalk.cyan(`  Found ${taskList.length} local task(s). Pushing to SaaS...`));

  const apiUrl = getApiUrl();
  let workspaceId = opts.workspace;
  if (!workspaceId) {
    const saved = await readWorkspace();
    if (saved) {
      workspaceId = saved.id;
      // Stryker disable once StringLiteral: display message for workspace selection
      console.log(chalk.dim(`  Using board: ${saved.icon ?? ""} ${saved.name}`));
    }
  }
  const requestBody: { tasks: unknown[]; workspaceId?: string } = { tasks: taskList };
  if (workspaceId) requestBody.workspaceId = workspaceId;

  let result: ImportResult;
  try {
    const res = await fetch(`${apiUrl}/api/cli/import`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as Record<string, unknown>;
      // Stryker disable once StringLiteral: display message for import failure
      console.error(chalk.red(`  Import failed: ${res.status} ${(err.error as string) ?? res.statusText}`));
      process.exitCode = 1;
      return;
    }

    result = await res.json() as ImportResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Stryker disable once StringLiteral: display message for network error
    console.error(chalk.red(`  Network error: ${msg}`));
    process.exitCode = 1;
    return;
  }

  // Stryker disable once StringLiteral: display message for push success
  console.log(chalk.green(`  ✓ Pushed ${result.imported} task(s) to SaaS`));
  if (result.skipped && result.skipped > 0) {
    // Stryker disable once StringLiteral: display message for skipped tasks
    console.log(chalk.dim(`  Skipped ${result.skipped} already-imported task(s).`));
  }
  const boardLabel = (await readWorkspace())?.name ?? result.workspaceId;
  // Stryker disable once StringLiteral: display message for board label
  console.log(chalk.dim(`  Board: ${boardLabel}`));

  // Upload local files for each pushed task (idMap: cliId → saasId)
  const idMap = result.idMap ?? {};
  const taskMappings = taskList
    .filter((t) => t.id && idMap[t.id])
    .map((t) => ({ localId: t.id!, remoteId: idMap[t.id!]! }));

  const { uploaded, failed, failedFiles } = await uploadTaskFiles(apiUrl, token, projectDir, taskMappings);
  if (uploaded > 0) console.log(chalk.green(`  ✓ Uploaded ${uploaded} file(s) to storage`));
  if (failed > 0) {
    // Stryker disable once StringLiteral: display message for upload failures
    console.log(chalk.yellow(`  ⚠ ${failed} file(s) failed to upload`));
    for (const f of failedFiles) {
      // Stryker disable once StringLiteral: display message for failed file
      console.log(chalk.dim(`    - ${f.name}: ${f.reason}`));
    }
  }

  if (opts.keepLocalFiles) {
    // Stryker disable once StringLiteral: display message for keep local files
    console.log(chalk.dim("  Local task files kept (--keep-local-files)."));
    return;
  }

  let deleted = 0;
  for (const task of taskList) {
    try {
      unlinkSync(task.filePath);
      deleted++;
    } catch {
      // ignore — file may have already been removed
    }
  }

  // Stryker disable once StringLiteral: display message for deleted files
  console.log(chalk.dim(`  Deleted ${deleted} local task file(s).`));
}

