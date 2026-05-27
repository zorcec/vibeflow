import { Command } from "commander";
import { execSync, execFileSync } from "node:child_process";
import { serve } from "./server/server.js";
import { createTask, listTasks, listTasksWithPaths, updateTask, formatTaskForAgent, renderTaskForAgent, renderAgentInstructions, generateTaskId, ensureTaskDirs } from "./core/tasks.js";
import { listComments, addComment } from "./core/comments.js";
import { listFiles } from "./core/files.js";
import { readConfig } from "./core/config.js";
import { loadSettings } from "./core/settings.js";
import type { Task, TaskStatus } from "./core/types.js";
import { getMode } from "./auth/mode.js";
import { login, maybeRefreshSettings } from "./auth/login.js";
import { logout } from "./auth/logout.js";
import { push } from "./commands/push.js";
import { fetchSaasTasks, fetchSaasTask, updateSaasTask, addSaasComment, createSaasTask, toCliStatus } from "./saas/client.js";
import { readWorkspace } from "./auth/workspace.js";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import chalk from "chalk";
import { capture, flushTelemetry, isTelemetryEnabled, setTelemetryEnabled, getTelemetryStatus } from "./telemetry.js";

// Injected at build time by tsup; undefined in raw TypeScript runs.
declare const __VIBEFLOW_CLI_VERSION__: string | undefined;

/** Compares semver strings; returns true if `latest` is strictly newer than `current`. */
function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string) => v.replace(/[^0-9.]/g, "").split(".").map(Number);
  const [la = 0, lb = 0, lc = 0] = parts(latest);
  const [ca = 0, cb = 0, cc = 0] = parts(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

/**
 * Non-blocking npm update check. Fires an HTTPS request to the npm registry
 * and prints a visible notice when a newer version is available.
 * Never throws; all errors are silently swallowed.
 */
function checkForUpdates(): void {
  const current = typeof __VIBEFLOW_CLI_VERSION__ !== "undefined" ? __VIBEFLOW_CLI_VERSION__ : null;
  if (!current) return;
  const pkgName = "@vibeflow-tools/cli";
  import("node:https").then(({ default: https }) => {
    const req = https.get(
      `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`,
      { timeout: 5000 },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          try {
            const { version: latest } = JSON.parse(body) as { version?: string };
            if (latest && isNewerVersion(latest, current)) {
              console.log();
              console.log(chalk.bgYellow.black.bold(` ↑ Update available: ${current} → ${latest} `));
              console.log(chalk.dim("  Run: ") + chalk.cyan(`npm install -g ${pkgName}@${latest}`) + chalk.dim(" to update"));
              console.log();
            }
          } catch { /* ignore parse errors */ }
        });
      },
    );
    req.on("error", () => { /* ignore network errors */ });
    req.on("timeout", () => { req.destroy(); });
  }).catch(() => { /* ignore */ });
}

// Background: refresh SaaS settings if stale (fire-and-forget, non-blocking)
void maybeRefreshSettings();

const STATUS_COLORS: Record<string, (s: string) => string> = {
  backlog: chalk.gray,
  todo: chalk.yellow,
  "in-progress": chalk.blue,
  review: chalk.magenta,
  done: chalk.green,
};

const VALID_TASK_TYPES = new Set(["Task", "Bug", "Research"]);

/** All valid task status values. */
const VALID_STATUSES = ["backlog", "todo", "in-progress", "review", "done"] as const;

/** Ascending comparator for objects with a `createdAt` ISO string field. */
const sortByCreatedAt = <T extends { createdAt: string }>(a: T, b: T): number =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

/** Returns the status count summary line (e.g. "Total: 10 | Backlog: 2 | Todo: 3 | ..."). */
function formatStatusSummary(tasks: { status: string }[]): string {
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  return `  Total: ${tasks.length} | Backlog: ${count("backlog")} | Todo: ${count("todo")} | In Progress: ${count("in-progress")} | Review: ${count("review")} | Done: ${count("done")}`;
}

/** Normalize task type: invalid or legacy values fall back to the generic "Task" type. */
function normalizeTaskType(type: string | undefined | null): string | undefined {
  if (!type) return undefined;
  // Match case-insensitively
  for (const valid of VALID_TASK_TYPES) {
    if (valid.toLowerCase() === type.toLowerCase()) return valid;
  }
  // Unknown type (e.g. '[object Object]', legacy strings) → null (omitted from display)
  return undefined;
}

function getPriorityRank(priority?: string): number {
  const value = (priority ?? "Medium").trim().toLowerCase();
  if (value === "critical") return 0;
  if (value === "high") return 1;
  if (value === "low") return 3;
  return 2; // medium/default
}

// Matches Kanban column order: in-progress → review → todo → backlog → done
const KANBAN_STATUS_ORDER = ['in-progress', 'review', 'todo', 'backlog', 'done'] as const;
function getStatusRank(status: string): number {
  const idx = KANBAN_STATUS_ORDER.indexOf(status as typeof KANBAN_STATUS_ORDER[number]);
  return idx === -1 ? KANBAN_STATUS_ORDER.length : idx;
}

function tryAutoPush(projectDir: string): { ok: boolean; error?: string } {
  try {
    execFileSync("git", ["push"], { cwd: projectDir, stdio: "inherit" });
    return { ok: true };
  } catch {
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: projectDir }).toString().trim();
      execFileSync("git", ["push", "--set-upstream", "origin", branch], { cwd: projectDir, stdio: "inherit" });
      return { ok: true };
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      return { ok: false, error: msg.slice(0, 220) };
    }
  }
}

function printAgentInstructions(opts: { hasResearchTasks: boolean; hasBugTasks?: boolean; autoCommit?: boolean; autoPush?: boolean; autoComment?: boolean; createBranch?: boolean }) {
  const text = renderAgentInstructions(opts);
  for (const line of text.split("\n")) {
    if (line.startsWith("Agent instructions")) {
      console.log(chalk.bold(line));
    } else if (line.startsWith("    ⚠")) {
      console.log(chalk.yellow(line));
    } else if (line.startsWith("  CRITICAL:")) {
      console.log(chalk.red(line));
    } else {
      console.log(chalk.dim(line));
    }
  }
}

/** Valid task type values for the --type filter. */
const VALID_FILTER_TYPES = ["Task", "Bug", "Feature", "Enhancement", "Research"];

/** Trim and lowercase a filter string for case-insensitive comparison. */
const normalizeFilterValue = (value: string): string => value.trim().toLowerCase();

/** True when `author` matches the user filter (case-insensitive). */
function matchesUserFilter(author: string | null | undefined, filter: string): boolean {
  const normalizedFilter = normalizeFilterValue(filter);
  if (!normalizedFilter) return true;
  return normalizeFilterValue(author ?? "") === normalizedFilter;
}

/** Returns sorted unique list of non-empty author strings from a task array. */
function collectAvailableUsers<T extends { author?: string | null }>(tasks: T[]): string[] {
  return [...new Set(
    tasks.map((t) => t.author?.trim()).filter((a): a is string => Boolean(a)),
  )].sort((a, b) => a.localeCompare(b));
}

/** Validates --type filter value; logs error and sets exitCode=1 if invalid. Returns true if valid. */
function validateTypeFilter(typeFilter: string): boolean {
  if (VALID_FILTER_TYPES.map((t) => t.toLowerCase()).includes(typeFilter.toLowerCase())) return true;
  console.log(chalk.red(`✗ Invalid type filter: "${typeFilter}"`));
  console.log(chalk.yellow(`  Available types: ${VALID_FILTER_TYPES.join(" | ")}`));
  console.log(chalk.dim("  Type filter is exact (example: --type Bug)"));
  process.exitCode = 1;
  return false;
}

/** Validates --user filter value; logs error and sets exitCode=1 if invalid. Returns true if valid. */
function validateUserFilter<T extends { author?: string | null }>(userFilter: string, tasks: T[]): boolean {
  const availableUsers = collectAvailableUsers(tasks);
  if (availableUsers.length === 0) {
    console.log(chalk.red(`✗ Cannot filter by user: no task authors are available on this board.`));
    process.exitCode = 1;
    return false;
  }
  if (availableUsers.some((author) => matchesUserFilter(author, userFilter))) return true;
  console.log(chalk.red(`✗ User not found: "${userFilter}"`));
  console.log(chalk.yellow(`  Available users: ${availableUsers.join(" | ")}`));
  console.log(chalk.dim("  User filter is exact email match (case-insensitive)."));
  process.exitCode = 1;
  return false;
}

/** Prints a single task's details in the agent-readable list format. */
function printTaskDetails(
  task: ReturnType<typeof listTasksWithPaths>[number],
  agent: ReturnType<typeof formatTaskForAgent>,
  idx: number,
  port: number,
  projectDir: string,
): void {
  const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
  console.log(`  ${chalk.dim(`${idx + 1}.`)} ${colorFn(`[${agent.status}]`)} ${agent.title}`);
  console.log(chalk.dim(`    id:       ${agent.id}`));
  console.log(chalk.dim(`    file:     ${task.filePath}`));
  if (agent.file) console.log(chalk.dim(`    source:   ${agent.file}${agent.line != null ? `:${agent.line}` : ""}${agent.col != null ? `:${agent.col}` : ""}`));
  if (agent.component) console.log(chalk.dim(`    component: ${agent.component}`));
  console.log(chalk.dim(`    selector: ${agent.selector}`));
  if (task.cssSelector) console.log(chalk.dim(`    css:      ${task.cssSelector}`));
  if (agent.url) console.log(chalk.dim(`    url:      ${agent.url}`));
  if (task.screenshot) console.log(chalk.dim(`    screenshot: http://localhost:${port}/screenshots/${task.screenshot}`));
  if (task.commits && task.commits.length > 0) {
    if (task.commits.length === 1) {
      console.log(chalk.dim(`    commit:   ${task.commits[0].sha}`));
    } else {
      console.log(chalk.dim(`    commits (${task.commits.length}):`));
      for (const c of task.commits) {
        console.log(chalk.dim(`      ${c.sha.slice(0, 8)}  ${c.timestamp}  ${c.message.slice(0, 60)}`));
      }
    }
  }
  if (task.branchName) console.log(chalk.dim(`    branch:   ${task.branchName}`));
  console.log(chalk.dim(`    created:  ${agent.created}`));
  if (agent.type) console.log(chalk.dim(`    type:     ${agent.type}`));
  if (agent.priority) console.log(chalk.dim(`    priority: ${agent.priority}`));
  if (agent.description) {
    console.log(chalk.dim(`    description:`));
    for (const line of agent.description.split("\n")) console.log(chalk.dim(`      ${line}`));
  }
  if (agent.structuredComments && agent.structuredComments.length > 0) {
    console.log(chalk.dim(`    comments (${agent.structuredComments.length}):`));
    for (const c of agent.structuredComments) {
      const edited = c.updatedAt ? ` (edited ${c.updatedAt})` : "";
      console.log(chalk.dim(`      [${c.author ?? "agent"}] ${c.createdAt}${edited}`));
      for (const line of c.text.split("\n")) console.log(chalk.dim(`        ${line}`));
    }
  }
  if (agent.linkedFiles && agent.linkedFiles.length > 0) {
    console.log(chalk.dim(`    linked files (${agent.linkedFiles.length}):`));
    for (const f of agent.linkedFiles) {
      const absPath = f.linkedPath ?? join(projectDir, ".vibeflow", "files", task.id, f.name);
      console.log(chalk.dim(`      - ${f.name}  ${f.url}`));
      // Inline content for text/markdown files so agents have full context immediately.
      if (/\.(md|txt)$/i.test(f.name) && f.size < 100_000 && existsSync(absPath)) {
        try {
          const content = readFileSync(absPath, "utf-8");
          console.log(chalk.dim(`        ┌── content ──`));
          for (const line of content.split("\n")) console.log(chalk.dim(`        │  ${line}`));
          console.log(chalk.dim(`        └─────────────`));
        } catch { /* file not readable — URL shown above */ }
      }
    }
  }
  console.log();
}

const program = new Command();

program
  .name("vibeflow")
  .description(
    "Vibeflow — CLI tool for frontend prototyping with LLM assistance",
  )
  .version(typeof __VIBEFLOW_CLI_VERSION__ !== "undefined" ? __VIBEFLOW_CLI_VERSION__ : "0.0.0");

program.addHelpText("after", `
${"─".repeat(60)}
For coding agents — quick reference:

  vibeflow tasks                       List all tasks
  vibeflow tasks --status todo         Filter to open tasks
  vibeflow tasks --tag <tag>           Filter by tag (repeatable for AND)
  vibeflow tasks --get <id>            Full task details
  vibeflow tasks --edit <id> --set-status in-progress
  vibeflow serve [target]              Start local server / prototype viewer
  vibeflow kanban                      Open the Kanban board in browser

Task statuses: backlog | todo | in-progress | review | done

Typical implement workflow:
  1. vibeflow tasks --status todo
  2. vibeflow tasks --edit <id> --set-status in-progress   # claim first
  3. vibeflow tasks --get <id>                             # read full details
  4. <implement the change>
  5. git add <changed files>
  6. vibeflow tasks --edit <id> --set-status review \\
       --commit-message "feat: ..." --comment "what changed and why"

File attachments:
  You can attach .md reports and other files to any task.
  Files are stored in .vibeflow/ and visible in the Kanban Files tab.
  Upload via the API:
    POST /api/tasks/<id>/files?filename=report.md
    Content-Type: application/octet-stream
    <file binary body>
  List:   GET  /api/tasks/<id>/files
  Delete: DELETE /api/tasks/<id>/files/<filename>
`);



program
  .command("serve")
  .description("Serve HTML prototype(s) with live overlay, or start API-only task server for existing apps")
  .argument("[target]", "HTML file or directory of HTML files")
  .option("-p, --port <port>", "Port number", "3700")
  .option("--host <host>", "Bind hostname (default: localhost; use 0.0.0.0 for LAN sharing)")
  .option("--no-open", "Do not open browser automatically")
  .action(async (target: string | undefined, opts: { port: string; open: boolean; host?: string }) => {
    capture("command_run", { command: "serve" });
    await flushTelemetry();
    await serve(target, {
      port: parseInt(opts.port, 10),
      host: opts.host,
      open: opts.open,
    });
  });

program
  .command("kanban")
  .description("Start the Vibeflow server and open the live Kanban board in the browser")
  .argument("[dir]", "Project root directory", ".")
  .option("-p, --port <port>", "Port number", "3700")
  .option("--host <host>", "Bind hostname (default: localhost; use 0.0.0.0 for LAN sharing)")
  .option("--no-open", "Do not open browser automatically")
  .action(async (dir: string, opts: { port: string; host?: string; open: boolean }) => {
    capture("command_run", { command: "kanban" });
    await flushTelemetry();
    const port = parseInt(opts.port, 10);
    const instance = await serve(undefined, {
      port,
      host: opts.host,
      open: false,
      projectDir: resolve(dir),
      noCtrlCHint: true,
    });
    const kanbanUrl = instance.url + "/kanban";
    console.log();
    console.log(chalk.green("  ✓ Kanban board ready"));
    console.log(chalk.dim("    ") + chalk.cyan(kanbanUrl));
    console.log();
    console.log(chalk.bold("Agent prompt:"));
    console.log(chalk.dim("  Get new tasks and implement them, once done check again for new ones:"));
    console.log(chalk.dim("  ") + chalk.green(`npx @vibeflow-tools/cli tasks --next`));
    console.log();
    console.log(chalk.dim("  Press Ctrl+C to stop"));
    console.log();
    if (opts.open) {
      import("open").then((mod) => mod.default(kanbanUrl)).catch(() => {
        console.log(chalk.dim("  Visit: ") + chalk.cyan(kanbanUrl));
      });
    }
    // Non-blocking update check — runs after all startup output is shown.
    void checkForUpdates();
  });



program
  .command("tasks")
  .description("List or edit tasks in the project")
  .argument("[dir]", "Project root directory", ".")
  .option("--status <status>", "Filter by status (backlog, todo, in-progress, review, done)")
  .option("--type <type>", "Filter by type (Task, Bug, Feature, Enhancement, Research)")
  .option("--user <user>", "Filter by exact task author email (case-insensitive)")
  .option("--edit [task-id]", "Edit a task by ID (LLM-friendly). Omit task-id to see usage instructions.")
  .option("--add", "Create a task (requires --title)")
  .option("--title <title>", "New title for the task (use with --edit)")
  .option("--set-status <status>", "New status: backlog | todo | in-progress | review | done (use with --edit)")
  .option("--description <text>", "New description for the task (use with --edit)")
  .option("--json", "Output machine-readable JSON")
  .option("--commit", "Commit staged changes and link the commit SHA to a task (use with --task)")
  .option("--task <task-id>", "Task ID to link with the commit (use with --commit)")
  .option("--message <msg>", "Commit message (use with --commit; task ID is appended automatically)")
  .option("--comment <text>", "Implementation report comment (required when setting status to review)")
  .option("--commit-message <msg>", "Commit message for auto-commit on review (required when auto-commit setting is ON)")
  .option("--get <task-id>", "Get full details of a single task by ID (supports partial ID prefix)")
  .option("--next", "Pick the next available todo task, move it to in-progress, and output it ready to work on")
  .option("--tag <tag>", "Filter by tag (can be specified multiple times for AND matching)", (val, prev: string[]) => [...prev, val], [] as string[])
  .option("--report-file <path>", "Path to a local .md file to upload as the research report (use with --set-status review on Research tasks; file is uploaded and deleted locally)")
  .option("--branch <name>", "Git branch name for the task (required when createBranch setting is ON and setting status to review)")
  .option("--limit <n>", "Limit how many tasks are returned in list mode (default: 5; use 0 for unlimited)")
  .action((dir: string, opts: {
    status?: string;
    type?: string;
    user?: string;
    edit?: string | boolean;
    add?: boolean;
    title?: string;
    setStatus?: string;
    description?: string;
    json?: boolean;
    commit?: boolean;
    get?: string;
    next?: boolean;
    task?: string;
    message?: string;
    comment?: string;
    commitMessage?: string;
    reportFile?: string;
    branch?: string;
    limit?: string;
    tag?: string[];
  }) => {
    void (async () => {
    // Determine sub-command for telemetry before async operations
    const taskSubcommand = opts.add ? "add" : opts.next ? "next" : opts.edit ? "edit" : opts.get ? "get" : "list";
    capture("command_run", { command: "tasks", subcommand: taskSubcommand });

    // ── Get single task mode ───────────────────────────────────────────
    if (opts.get) {
      const getTaskMode = await getMode();
      if (getTaskMode === "saas") {
        const workspace = await readWorkspace();
        const saasData = await fetchSaasTasks(workspace?.id);
        if (!saasData) {
          console.log(chalk.red("✗ Unable to reach the online backend."));
          process.exitCode = 1;
          return;
        }
        const saasTask = saasData.tasks.find((t) => t.id === opts.get || t.id.startsWith(opts.get!));
        if (!saasTask) {
          console.log(chalk.red(`✗ Task not found: ${opts.get}`));
          process.exitCode = 1;
          return;
        }
        const cliStatus = toCliStatus(saasTask.status);
        if (opts.json) {
          console.log(JSON.stringify({ ...saasTask, status: cliStatus }, null, 2));
          return;
        }
        const colorFnSaas = STATUS_COLORS[cliStatus] ?? chalk.white;
        console.log(`  ${colorFnSaas(`[${cliStatus}]`)} ${chalk.bold(saasTask.title)}`);
        console.log(chalk.dim(`    id:       ${saasTask.id}`));
        console.log(chalk.dim(`    selector: /`));
        if (saasTask.type) console.log(chalk.dim(`    type:     ${saasTask.type}`));
        if (saasTask.priority) console.log(chalk.dim(`    priority: ${saasTask.priority}`));
        console.log(chalk.dim(`    created:  ${saasTask.createdAt}`));
        if (saasTask.description) {
          console.log(chalk.dim(`    description:`));
          for (const line of saasTask.description.split("\n")) console.log(chalk.dim(`      ${line}`));
        }
        if (saasTask.annotatedElementText) {
          console.log(chalk.dim(`    element text: ${saasTask.annotatedElementText}`));
        }
        if (saasTask.branchName) console.log(chalk.dim(`    branch:   ${saasTask.branchName}`));
        const saasComments = [...(saasTask.comments ?? [])].sort(
          sortByCreatedAt,
        );
        if (saasComments.length > 0) {
          console.log(chalk.dim(`    comments (${saasComments.length}):`));
          for (const c of saasComments) {
            console.log(chalk.dim(`      [${(c as { author?: string }).author ?? "agent"}] ${c.createdAt}`));
            for (const line of c.body.split("\n")) console.log(chalk.dim(`        ${line}`));
          }
        }
        if (saasTask.files && saasTask.files.length > 0) {
          console.log(chalk.dim(`    linked files (${saasTask.files.length}):`));
          for (const f of saasTask.files) {
            const fileUrl = f.url ?? `${process.env.VIBEFLOW_API_URL ?? "https://app.vibeflow.tools"}/api/tasks/${saasTask.id}/files/${encodeURIComponent(f.name)}`;
            console.log(chalk.dim(`      - ${f.name}  ${fileUrl}`));
            if (f.content) {
              console.log(chalk.dim(`        ┌── content ──`));
              for (const line of f.content.split("\n")) console.log(chalk.dim(`        │  ${line}`));
              console.log(chalk.dim(`        └─────────────`));
            }
          }
        }
        const saasGetSettings = loadSettings(resolve(dir));
        const isResearch = (saasTask.type ?? "").toLowerCase() === "research";
        const isBug = (saasTask.type ?? "").toLowerCase() === "bug";
        printAgentInstructions({ hasResearchTasks: isResearch, hasBugTasks: isBug, autoCommit: saasGetSettings.autoCommit, autoPush: saasGetSettings.autoPush, autoComment: saasGetSettings.autoComment, createBranch: saasGetSettings.createBranch });
        return;
      }

      // ── Local mode ──
      const projectDir = resolve(dir);
      const config = readConfig(projectDir);
      const allWithPaths = listTasksWithPaths(projectDir);
      const task = allWithPaths.find((t) => t.id === opts.get || t.id.startsWith(opts.get!));
      if (!task) {
        console.log(chalk.red(`✗ Task not found: ${opts.get}`));
        console.log(chalk.dim("  Run 'vibeflow tasks' to see available task IDs."));
        process.exitCode = 1;
        return;
      }
      const structuredComments = listComments(projectDir, task.id).sort(
        sortByCreatedAt,
      );
      const linkedFiles = listFiles(projectDir, task.id).map((f) => ({
        ...f,
        url: `http://localhost:${config.port}${f.url}`,
      }));
      const agent = formatTaskForAgent(task, structuredComments, linkedFiles);
      if (opts.json) {
        console.log(JSON.stringify({ ...task, comments: structuredComments, files: linkedFiles }, null, 2));
        return;
      }
      const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
      const agentMessage = renderTaskForAgent(task, task.filePath, structuredComments, linkedFiles, projectDir);
      // Prepend the colored status/title line, then print the rest dimmed
      const agentLines = agentMessage.split("\n");
      if (agentLines.length > 0) {
        const firstLine = agentLines[0];
        const match = firstLine.match(/^\[(\w+)\]\s+(.+)$/);
        if (match) {
          console.log(`  ${colorFn(`[${match[1]}]`)} ${chalk.bold(match[2])}`);
        } else {
          console.log(chalk.dim(firstLine));
        }
        for (let i = 1; i < agentLines.length; i++) {
          console.log(chalk.dim(agentLines[i]));
        }
      }
      const localGetSettings = loadSettings(projectDir);
      const isLocalResearch = (task.type ?? "").toLowerCase() === "research";
      const isLocalBug = (task.type ?? "").toLowerCase() === "bug";
      printAgentInstructions({ hasResearchTasks: isLocalResearch, hasBugTasks: isLocalBug, autoCommit: localGetSettings.autoCommit, autoPush: localGetSettings.autoPush, autoComment: localGetSettings.autoComment, createBranch: localGetSettings.createBranch });
      return;
    }

    // ── Next mode ──────────────────────────────────────────────────────
    if (opts.next) {
      const nextMode = await getMode();
      if (nextMode === "saas") {
        const nextWorkspace = await readWorkspace();
        const saasData = await fetchSaasTasks(nextWorkspace?.id);
        if (!saasData) {
          console.log(chalk.red("✗ Unable to reach the online backend."));
          process.exitCode = 1;
          return;
        }
        if (opts.type && !validateTypeFilter(opts.type)) return;
        let todoTasks = saasData.tasks
          .map((t) => ({ ...t, status: toCliStatus(t.status) }))
          .filter((t) => t.status === "todo");
        if (opts.type) todoTasks = todoTasks.filter((t) => (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase());
        if (opts.user && !validateUserFilter(opts.user, todoTasks)) return;
        if (opts.user) todoTasks = todoTasks.filter((t) => matchesUserFilter(t.author, opts.user!));
        if (opts.tag && opts.tag.length > 0) todoTasks = todoTasks.filter((t) => opts.tag!.every(tag => ((t as { tags?: string[] }).tags ?? []).includes(tag)));
        todoTasks = todoTasks.sort((a, b) => {
          const byPriority = getPriorityRank(a.priority ?? undefined) - getPriorityRank(b.priority ?? undefined);
          if (byPriority !== 0) return byPriority;
          return sortByCreatedAt(a, b);
        });

        if (todoTasks.length === 0) {
          const filterHints = [opts.type && `type=${opts.type}`, opts.user && `user=${opts.user}`, opts.tag?.length && `tag=${opts.tag.join(",")}`].filter(Boolean);
          const suffix = filterHints.length > 0 ? ` matching ${filterHints.join(" ")}` : "";
          console.log(chalk.dim(`No todo tasks found${suffix}. Nothing to work on.`));
          return;
        }

        const nextTask = todoTasks[0];
        const updated = await updateSaasTask(nextTask.id, { status: "in-progress" });
        if (!updated) {
          console.log(chalk.red(`✗ Failed to move task to in-progress: ${nextTask.id}`));
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify({ ...nextTask, status: "in-progress" }, null, 2));
          return;
        }

        const nextSettings = loadSettings(resolve(dir));
        const isResearch = (nextTask.type ?? "").toLowerCase() === "research";
        const isBug = (nextTask.type ?? "").toLowerCase() === "bug";
        printAgentInstructions({ hasResearchTasks: isResearch, hasBugTasks: isBug, autoCommit: nextSettings.autoCommit, autoPush: nextSettings.autoPush, autoComment: nextSettings.autoComment, createBranch: nextSettings.createBranch });

        console.log(chalk.green.bold("▶ NEXT TASK — Status moved to in-progress. Implement this now:"));
        console.log();
        console.log(`  ${chalk.blue(`[in-progress]`)} ${chalk.bold(nextTask.title)}`);
        console.log(chalk.dim(`    id:       ${nextTask.id}`));
        if (nextTask.type) console.log(chalk.dim(`    type:     ${nextTask.type}`));
        if (nextTask.priority) console.log(chalk.dim(`    priority: ${nextTask.priority}`));
        console.log(chalk.dim(`    created:  ${nextTask.createdAt}`));
        if (nextTask.description) {
          console.log(chalk.dim(`    description:`));
          for (const line of nextTask.description.split("\n")) console.log(chalk.dim(`      ${line}`));
        }
        const sortedNextComments = [...(nextTask.comments ?? [])].sort(
          sortByCreatedAt,
        );
        if (sortedNextComments.length > 0) {
          console.log(chalk.dim(`    comments (${sortedNextComments.length}):`));
          for (const c of sortedNextComments) {
            const author = (c as { authorId?: string }).authorId ? `user:${(c as { authorId?: string }).authorId!.slice(0, 8)}` : "agent";
            console.log(chalk.dim(`      [${author}] ${c.createdAt}`));
            for (const line of c.body.split("\n")) console.log(chalk.dim(`        ${line}`));
          }
        }
        console.log();
        console.log(chalk.yellow("  ⚡ This task is already in-progress. Implement it now and mark as review when done."));
        return;
      }

      // ── Local next mode ──────────────────────────────────────────────
      const nextProjectDir = resolve(dir);
      const allTasks = listTasksWithPaths(nextProjectDir);
      if (opts.type && !validateTypeFilter(opts.type)) return;
      let todoList = allTasks.filter((t) => t.status === "todo");
      if (opts.type) todoList = todoList.filter((t) => (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase());
      if (opts.user && !validateUserFilter(opts.user, todoList)) return;
      if (opts.user) todoList = todoList.filter((t) => matchesUserFilter(t.author, opts.user!));
      if (opts.tag && opts.tag.length > 0) todoList = todoList.filter((t) => opts.tag!.every(tag => (t.tags ?? []).includes(tag)));
      todoList = todoList.sort((a, b) => {
        const byPriority = getPriorityRank(a.priority) - getPriorityRank(b.priority);
        if (byPriority !== 0) return byPriority;
        return new Date(a.created).getTime() - new Date(b.created).getTime();
      });

      if (todoList.length === 0) {
        const filterHints = [opts.type && `type=${opts.type}`, opts.user && `user=${opts.user}`, opts.tag?.length && `tag=${opts.tag.join(",")}`].filter(Boolean);
        const suffix = filterHints.length > 0 ? ` matching ${filterHints.join(" ")}` : "";
        console.log(chalk.dim(`No todo tasks found${suffix}. Nothing to work on.`));
        return;
      }

      const nextLocalTask = todoList[0];
      const nextUpdated = updateTask(nextProjectDir, nextLocalTask.id, { status: "in-progress" });
      if (!nextUpdated) {
        console.log(chalk.red(`✗ Failed to update task: ${nextLocalTask.id}`));
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...nextUpdated, filePath: nextLocalTask.filePath }, null, 2));
        return;
      }

      const nextLocalSettings = loadSettings(nextProjectDir);
      const isLocalNextResearch = (nextUpdated.type ?? "").toLowerCase() === "research";
      const isLocalNextBug = (nextUpdated.type ?? "").toLowerCase() === "bug";
      printAgentInstructions({ hasResearchTasks: isLocalNextResearch, hasBugTasks: isLocalNextBug, autoCommit: nextLocalSettings.autoCommit, autoPush: nextLocalSettings.autoPush, autoComment: nextLocalSettings.autoComment, createBranch: nextLocalSettings.createBranch });

      const config = readConfig(nextProjectDir);
      const structuredComments = listComments(nextProjectDir, nextUpdated.id).sort(
        sortByCreatedAt,
      );
      const linkedFiles = listFiles(nextProjectDir, nextUpdated.id).map((f) => ({
        ...f,
        url: `http://localhost:${config.port}${f.url}`,
      }));
      const agentMessage = renderTaskForAgent(nextUpdated, nextLocalTask.filePath, structuredComments, linkedFiles, nextProjectDir);

      console.log(chalk.green.bold("▶ NEXT TASK — Status moved to in-progress. Implement this now:"));
      console.log();
      const agentLines = agentMessage.split("\n");
      if (agentLines.length > 0) {
        const match = agentLines[0].match(/^\[(\w+)\]\s+(.+)$/);
        if (match) {
          console.log(`  ${chalk.blue(`[${match[1]}]`)} ${chalk.bold(match[2])}`);
        } else {
          console.log(chalk.dim(agentLines[0]));
        }
        for (let i = 1; i < agentLines.length; i++) {
          console.log(chalk.dim(agentLines[i]));
        }
      }
      console.log();
      console.log(chalk.yellow("  ⚡ This task is already in-progress. Implement it now and mark as review when done."));
      return;
    }

    // ── Add mode ───────────────────────────────────────────────────────
    if (opts.add) {
      if (!opts.title?.trim()) {
        console.log(chalk.red("✗ --title is required with --add"));
        console.log(chalk.dim("  Example: vibeflow tasks --add --title \"Fix CTA spacing\" --description \"Button overflows on mobile\""));
        process.exitCode = 1;
        return;
      }

      const addMode = await getMode();
      if (addMode === "saas") {
        const addWorkspace = await readWorkspace();
        const validSaasStatuses = ["backlog", "todo", "in-progress", "review", "done"];
        const saasStatus = validSaasStatuses.includes(opts.setStatus ?? "") ? opts.setStatus : "todo";
        const newId = generateTaskId();
        const saasCreated = await createSaasTask({
          id: newId,
          title: opts.title.trim(),
          description: opts.description?.trim(),
          status: saasStatus,
          boardId: addWorkspace?.id,
        });
        if (!saasCreated) {
          console.log(chalk.red("✗ Failed to create task in online board."));
          console.log(chalk.yellow("  Check your connection or run 'vibeflow login'."));
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(saasCreated, null, 2));
        } else {
          console.log(chalk.green(`✓ Task created: ${saasCreated.title}`));
          console.log(chalk.dim(`  id: ${saasCreated.id} | status: ${toCliStatus(saasCreated.status)}`));
        }
        return;
      }

      const projectDir = resolve(dir);
      ensureTaskDirs(projectDir);
      const validStatuses = ["backlog", "todo", "in-progress", "review", "done"];
      const status = validStatuses.includes(opts.setStatus ?? "")
        ? (opts.setStatus as TaskStatus)
        : "todo";

      const created = createTask(projectDir, {
        title: opts.title.trim(),
        description: opts.description?.trim() ?? "",
        status,
        selector: "/",
      });

      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log(chalk.green(`✓ Task created: ${created.title}`));
        console.log(chalk.dim(`  id: ${created.id} | status: ${created.status}`));
      }
      return;
    }

    // ── Commit mode ────────────────────────────────────────────────────
    if (opts.commit) {
      if (!opts.task) {
        console.log(chalk.red("✗ --task <task-id> is required with --commit"));
        console.log(chalk.dim("  Example: vibeflow tasks --commit --task abc12345 --message \"fix button alignment\""));
        process.exitCode = 1;
        return;
      }
      const projectDir = resolve(dir);
      const tasks = listTasks(projectDir);
      const task = tasks.find((t) => t.id === opts.task || t.id.startsWith(opts.task!));
      if (!task) {
        console.log(chalk.red(`✗ Task not found: ${opts.task}`));
        console.log(chalk.dim("  Run 'vibeflow tasks' to see available task IDs."));
        process.exitCode = 1;
        return;
      }
      const baseMsg = opts.message?.trim() || task.title;
      // Warn when committing for a Research task — code changes should not be made.
      if ((task.type ?? '').toLowerCase() === 'research') {
        console.log(chalk.yellow("⚠  WARNING: This is a Research task. Research tasks must NOT produce code changes."));
        console.log(chalk.yellow("   Only commit research report files (.md). Do not commit code changes."));
        console.log();
      }
      const commitMsg = `${baseMsg} [proto:${task.id}]`;
      try {
        execFileSync("git", ["commit", "-m", commitMsg], {
          cwd: projectDir,
          stdio: "inherit",
        });
        const sha = execSync("git rev-parse HEAD", { cwd: projectDir }).toString().trim();
        const commitRecord = { sha, message: baseMsg, timestamp: new Date().toISOString() };
        const existingCommits = task.commits ?? [];
        updateTask(projectDir, task.id, { commits: [...existingCommits, commitRecord] });
        console.log(chalk.green(`✓ Committed and linked to task: ${task.title}`));
        console.log(chalk.dim(`  commit: ${sha}`));
        console.log(chalk.dim(`  proto:  ${task.id}`));

        const settings = loadSettings(projectDir);
        if (settings.autoPush) {
          console.log(chalk.dim("  auto-push: pushing commit to remote..."));
          const pushed = tryAutoPush(projectDir);
          if (pushed.ok) {
            console.log(chalk.green("✓ Auto-push complete"));
          } else {
            console.log(chalk.yellow("⚠ Auto-push failed. Commit is local; run 'git push' manually."));
            if (pushed.error) {
              console.log(chalk.dim(`  reason: ${pushed.error}`));
            }
          }
        }
      } catch {
        console.log(chalk.red("✗ git commit failed — ensure changes are staged with 'git add'"));
        process.exitCode = 1;
      }
      return;
    }

    // ── Edit mode ──────────────────────────────────────────────────────
    if (opts.edit !== undefined) {
      const taskId = typeof opts.edit === "string" ? opts.edit : undefined;
      const hasEdits = opts.title || opts.setStatus || opts.description;

      if (!taskId || !hasEdits) {
        if (opts.type && !validateTypeFilter(opts.type)) return;
        let all = listTasks(dir);
        if (opts.status) all = all.filter((t) => t.status === opts.status);
        if (opts.type) all = all.filter((t) => (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase());
        if (opts.user && !validateUserFilter(opts.user, all)) return;
        if (opts.user) all = all.filter((t) => matchesUserFilter(t.author, opts.user!));
        if (opts.tag && opts.tag.length > 0) all = all.filter((t) => opts.tag!.every(tag => (t.tags ?? []).includes(tag)));
        console.log(chalk.bold("vibeflow tasks --edit — LLM Usage Instructions"));
        console.log();
        console.log("Edit a task:");
        console.log(chalk.cyan("  vibeflow tasks [dir] --edit <task-id> [--title \"new title\"] [--set-status backlog|todo|in-progress|review|done] [--description \"new description\"]"));
        console.log();
        console.log("Examples:");
        console.log(chalk.dim("  vibeflow tasks --edit abc12345 --set-status done"));
        console.log(chalk.dim("  vibeflow tasks --edit abc12345 --set-status in-progress"));
        console.log(chalk.dim("  vibeflow tasks --edit abc12345 --title \"Updated title\" --description \"More detail\""));
        console.log();
        if (all.length === 0) {
          console.log(chalk.dim("No tasks found."));
        } else {
          console.log("Available tasks:");
          for (const task of all) {
            const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
            console.log(`  ${colorFn(`[${task.status}]`)} ${chalk.bold(task.id)} — ${task.title}`);
          }
        }
        return;
      }

      if (opts.setStatus === "done") {
        console.log(chalk.yellow("⚠ WARNING: Agents should NEVER set a task status to \"done\"."));
        console.log(chalk.yellow("  Only humans should mark tasks as done after reviewing."));
        console.log(chalk.dim("  If you are an agent, use --set-status review instead."));
        console.log();
      }

      if (opts.setStatus && !VALID_STATUSES.includes(opts.setStatus as typeof VALID_STATUSES[number])) {
        console.log(chalk.red(`✗ Invalid status: "${opts.setStatus}"`));
        console.log(chalk.yellow(`  Valid statuses: ${VALID_STATUSES.join(" | ")}`));
        console.log(chalk.dim(`  Example: vibeflow tasks --edit ${taskId} --set-status in-progress`));
        process.exitCode = 1;
        return;
      }

      if (opts.setStatus === "review" && !opts.comment?.trim()) {
        console.log(chalk.red("✗ --comment is required when setting status to review"));
        console.log(chalk.dim("  Provide a concise implementation report explaining:"));
        console.log(chalk.dim("    · what was changed and why"));
        console.log(chalk.dim("    · key decisions and trade-offs"));
        console.log(chalk.dim("    · anything future agents should know"));
        console.log(chalk.dim(`  Example: vibeflow tasks --edit ${taskId} --set-status review --comment "Implemented X by doing Y. Key decision: Z."`));
        process.exitCode = 1;
        return;
      }

      // ── Settings-based enforcement on review ─────────────────────────
      const editMode = await getMode();
      if (opts.setStatus === "review") {
        const projectDir = resolve(dir);
        const settings = loadSettings(projectDir);

        // Enforce --comment when autoComment is ON
        if (settings.autoComment && !opts.comment?.trim()) {
          console.log(chalk.red("✗ --comment is required (auto-comment setting is ON)"));
          console.log(chalk.dim("  Provide: what changed, why, key decisions, anything future agents should know."));
          console.log(chalk.dim("  Plain text for short notes; Markdown for multi-section reports."));
          console.log(chalk.dim(`  Example: vibeflow tasks --edit ${taskId} --set-status review --comment "Implemented X by doing Y."`));
          process.exitCode = 1;
          return;
        }

        // Validate --commit-message presence when autoCommit is ON.
        // The actual git commit runs after task status + comment are saved so that
        // a commit failure never prevents the comment from being persisted.
        if (settings.autoCommit && !opts.commitMessage?.trim()) {
          console.log(chalk.red("✗ --commit-message is required (auto-commit setting is ON)"));
          console.log(chalk.dim("  Stage your changes first, then provide a one-line commit summary."));
          console.log(chalk.dim(`  Example: vibeflow tasks --edit ${taskId} --set-status review --commit-message "fix: add hover effect" --comment "..."`));
          process.exitCode = 1;
          return;
        }

        // Enforce --branch when createBranch is ON.
        if (settings.createBranch && !opts.branch?.trim()) {
          console.log(chalk.red("✗ --branch is required (create-branch setting is ON)"));
          console.log(chalk.dim("  Provide the git branch name created for this task."));
          console.log(chalk.dim(`  Example: vibeflow tasks --edit ${taskId} --set-status review --branch feat/add-hover-effect --comment "..."`));
          process.exitCode = 1;
          return;
        }
      }

      // ── SaaS edit path (online mode) ────────────────────────────────
      if (editMode === "saas") {
        const saasPatch: { status?: string; title?: string; description?: string; branchName?: string } = {};
        if (opts.setStatus) saasPatch.status = opts.setStatus;
        if (opts.title) saasPatch.title = opts.title;
        if (opts.description) saasPatch.description = opts.description;
        if (opts.branch) saasPatch.branchName = opts.branch;

        // Conflict detection: warn when attempting in-progress on an already in-progress task
        if (opts.setStatus === "in-progress") {
          const current = await fetchSaasTask(taskId);
          if (current && toCliStatus(current.status) === "in-progress") {
            const assignee = current.author ?? "another user";
            console.log(chalk.yellow(`⚠  Task is already in-progress (last updated by: ${assignee})`));
            console.log(chalk.yellow("   Another agent or user may be working on this task."));
            console.log(chalk.yellow("   Proceeding — but verify the task is not being worked on elsewhere."));
            console.log();
          }
        }

        const saasResult = await updateSaasTask(taskId, saasPatch);
        if (!saasResult) {
          console.log(chalk.red(`✗ Failed to update task: ${taskId}`));
          console.log(chalk.yellow("  Ensure you are connected and the task ID exists in the online board."));
          process.exitCode = 1;
          return;
        }

        if (saasResult.warning) {
          console.log(chalk.yellow(`⚠  Server warning: ${saasResult.warning}`));
        }

        if (opts.setStatus === "review" && opts.comment?.trim()) {
          const commented = await addSaasComment(taskId, opts.comment.trim());
          if (commented) console.log(chalk.dim("  comment: added"));
        }

        console.log(chalk.green(`✓ Task updated: ${saasResult.task.title}`));
        console.log(chalk.dim(`  id: ${saasResult.task.id} | status: ${toCliStatus(saasResult.task.status)}`));
        return;
      }

      // ── Local edit path ──────────────────────────────────────────────
      const updates: Partial<Pick<Task, "status" | "title" | "description" | "branchName">> = {};
      if (opts.title) updates.title = opts.title;
      if (opts.setStatus) updates.status = opts.setStatus as TaskStatus;
      if (opts.description) updates.description = opts.description;
      if (opts.branch) updates.branchName = opts.branch;

      // Warn when setting a Research task to in-progress — should not implement.
      // Also detect in-progress conflicts (task already claimed by another agent/user).
      if (opts.setStatus === "in-progress") {
        const projectDir = resolve(dir);
        const tasks = listTasks(projectDir);
        const editedTask = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
        if (editedTask) {
          if ((editedTask.type ?? '').toLowerCase() === 'research') {
            console.log(chalk.yellow("⚠  WARNING: This is a Research task. Policy: do NOT implement code."));
            console.log(chalk.yellow("   Research only — attach a .md report file, leave a summary comment, mark as review."));
            console.log();
          }
          if (editedTask.status === "in-progress") {
            const lastUpdated = editedTask.updated ? new Date(editedTask.updated).toLocaleString() : "unknown";
            const assignee = editedTask.author ?? "another user";
            console.log(chalk.yellow(`⚠  Task is already in-progress (author: ${assignee}, last updated: ${lastUpdated})`));
            console.log(chalk.yellow("   Another agent or user may be working on this task."));
            console.log(chalk.yellow("   Proceeding — but verify the task is not being worked on elsewhere."));
            console.log();
          }
        }
      }

      // Enforce Research type rules before marking as review.
      if (opts.setStatus === "review") {
        const projectDir = resolve(dir);
        const tasks = listTasks(projectDir);
        const editedTask = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
        if (editedTask && (editedTask.type ?? '').toLowerCase() === 'research') {
          // Check if a --report-file was provided to upload now
          if (opts.reportFile) {
            const reportPath = resolve(opts.reportFile);
            if (!existsSync(reportPath)) {
              console.log(chalk.red(`✗ Report file not found: ${reportPath}`));
              process.exitCode = 1;
              return;
            }
            if (!/\.md$/i.test(reportPath)) {
              console.log(chalk.red("✗ Report file must be a Markdown (.md) file"));
              process.exitCode = 1;
              return;
            }
            const content = readFileSync(reportPath);
            const { saveFile: saveTaskFile } = await import('./core/files.js');
            saveTaskFile(projectDir, editedTask.id, basename(reportPath), content);
            unlinkSync(reportPath);
            console.log(chalk.green(`✓ Report uploaded: ${basename(reportPath)} (local file removed)`));
          } else {
            // No --report-file: check if at least one .md file is already attached
            const attachedFiles = listFiles(projectDir, editedTask.id);
            const hasMdFile = attachedFiles.some((f) => /\.md$/i.test(f.name));
            if (!hasMdFile) {
              console.log(chalk.red("✗ Cannot mark Research task as review: no .md report file attached."));
              console.log(chalk.dim("  Provide a research report:"));
              console.log(chalk.dim(`    vibeflow tasks --edit ${taskId} --set-status review --report-file ./my-research.md --comment "..."`));
              process.exitCode = 1;
              return;
            }
          }
        }
      }

      const updated = updateTask(dir, taskId, updates);
      if (!updated) {
        console.log(chalk.red(`✗ Task not found: ${taskId}`));
        console.log(chalk.yellow(`  Run 'vibeflow tasks' to see available task IDs.`));
        process.exitCode = 1;
        return;
      }

      // Add comment BEFORE the git commit attempt. This guarantees the comment is
      // always persisted even if auto-commit fails (e.g., nothing staged, git error).
      if (opts.setStatus === "review" && opts.comment?.trim()) {
        addComment(resolve(dir), taskId, "agent", opts.comment.trim());
        console.log(chalk.dim(`  comment: added`));
      }

      console.log(chalk.green(`✓ Task updated: ${updated.title}`));
      console.log(chalk.dim(`  id: ${updated.id} | status: ${updated.status}`));

      // ── Auto-commit (runs after task status + comment are already saved) ──────
      // Keeping this after updateTask/addComment ensures comment is preserved even
      // when git commit fails. Failure sets exitCode=1 but does NOT undo the task.
      if (opts.setStatus === "review") {
        const autoDir = resolve(dir);
        const autoSettings = loadSettings(autoDir);
        if (autoSettings.autoCommit && opts.commitMessage?.trim()) {
          const allAutoTasks = listTasks(autoDir);
          const taskForCommit = allAutoTasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
          if (taskForCommit) {
            const commitMsg = `${opts.commitMessage.trim()} [proto:${taskForCommit.id}]`;
            try {
              execFileSync("git", ["commit", "-m", commitMsg], { cwd: autoDir, stdio: "inherit" });
              const sha = execSync("git rev-parse HEAD", { cwd: autoDir }).toString().trim();
              const commitRecord = { sha, message: opts.commitMessage.trim(), timestamp: new Date().toISOString() };
              const existingCommits = taskForCommit.commits ?? [];
              updateTask(autoDir, taskForCommit.id, { commits: [...existingCommits, commitRecord] });
              console.log(chalk.green(`✓ Committed: ${commitMsg}`));
              console.log(chalk.dim(`  sha: ${sha}`));

              if (autoSettings.autoPush) {
                console.log(chalk.dim("  pushing..."));
                const pushed = tryAutoPush(autoDir);
                if (pushed.ok) {
                  console.log(chalk.green("✓ Pushed"));
                } else {
                  console.log(chalk.yellow("⚠ Push failed. Run 'git push' manually."));
                  if (pushed.error) console.log(chalk.dim(`  reason: ${pushed.error}`));
                }
              }
            } catch {
              // Task status and comment are already saved — only the commit failed.
              console.log(chalk.red("✗ git commit failed — ensure changes are staged with 'git add'"));
              process.exitCode = 1;
            }
          }
        }
      }

      return;
    }

    // ── List mode ──────────────────────────────────────────────────────
    if (opts.status && !VALID_STATUSES.includes(opts.status as typeof VALID_STATUSES[number])) {
      console.log(chalk.red(`✗ Invalid status filter: "${opts.status}"`));
      console.log(chalk.yellow(`  Valid statuses: ${VALID_STATUSES.join(" | ")}`));
      console.log(chalk.dim(`  Example: vibeflow tasks --status todo`));
      process.exitCode = 1;
      return;
    }
    if (opts.type && !validateTypeFilter(opts.type)) return;

    // ── SaaS online mode: fetch from backend ───────────────────────────
    const mode = await getMode();
    if (mode === "saas") {
      const workspace = await readWorkspace();
      const saasData = await fetchSaasTasks(workspace?.id);
      if (!saasData) {
        console.log(chalk.red("✗ Unable to reach the online backend."));
        console.log(chalk.yellow("  Check your connection or run 'vibeflow login' if your session expired."));
        process.exitCode = 1;
        return;
      }

      let saasTasks = saasData.tasks.map((t) => ({
        ...t,
        status: toCliStatus(t.status),
      }));
      if (opts.status) saasTasks = saasTasks.filter((t) => t.status === opts.status);
      if (opts.type) saasTasks = saasTasks.filter((t) => (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase());
      if (opts.user && !validateUserFilter(opts.user, saasTasks)) return;
      if (opts.user) saasTasks = saasTasks.filter((t) => matchesUserFilter(t.author, opts.user!));
      if (opts.tag && opts.tag.length > 0) saasTasks = saasTasks.filter((t) => opts.tag!.every(tag => ((t as { tags?: string[] }).tags ?? []).includes(tag)));

      const saasLimit = opts.limit !== undefined ? parseInt(opts.limit, 10) : 5;
      if (!isNaN(saasLimit) && saasLimit > 0) saasTasks = saasTasks.slice(0, saasLimit);

      if (opts.json) {
        console.log(JSON.stringify(saasTasks, null, 2));
        return;
      }

      const hasResearchTasks = saasTasks.some((t) => (t.type ?? "").toLowerCase() === "research");
      const hasBugTasks = saasTasks.some((t) => (t.type ?? "").toLowerCase() === "bug");

      const saasSettings = loadSettings(resolve(dir));
      printAgentInstructions({ hasResearchTasks, hasBugTasks, autoCommit: saasSettings.autoCommit, autoPush: saasSettings.autoPush, autoComment: saasSettings.autoComment, createBranch: saasSettings.createBranch });

      if (saasTasks.length === 0) {
        console.log(chalk.dim("No tasks found."));
      } else {
        saasTasks = saasTasks.sort((a, b) => {
          const byStatus = getStatusRank(a.status) - getStatusRank(b.status);
          if (byStatus !== 0) return byStatus;
          const byPriority = getPriorityRank(a.priority ?? undefined) - getPriorityRank(b.priority ?? undefined);
          if (byPriority !== 0) return byPriority;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });
        for (const [idx, task] of saasTasks.entries()) {
          const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
          const normalizedType = normalizeTaskType(task.type);
          console.log(`  ${chalk.dim(`${idx + 1}.`)} ${colorFn(`[${task.status}]`)} ${task.title}`);
          console.log(chalk.dim(`    id:       ${task.id}`));
          console.log(chalk.dim(`    selector: /`));
          if (normalizedType) console.log(chalk.dim(`    type:     ${normalizedType}`));
          if (task.priority) console.log(chalk.dim(`    priority: ${task.priority}`));
          console.log(chalk.dim(`    created:  ${task.createdAt}`));
          if (task.description) {
            console.log(chalk.dim(`    description:`));
            for (const line of task.description.split("\n")) console.log(chalk.dim(`      ${line}`));
          }
          if (task.comments && task.comments.length > 0) {
            const sortedComments = [...task.comments].sort(
              sortByCreatedAt,
            );
            console.log(chalk.dim(`    comments (${sortedComments.length}):`));
            for (const c of sortedComments) {
              // SaasComment has authorId (not author) and body (not text).
              const author = c.authorId ? `user:${c.authorId.slice(0, 8)}` : "agent";
              console.log(chalk.dim(`      [${author}] ${c.createdAt}`));
              for (const line of c.body.split("\n")) console.log(chalk.dim(`        ${line}`));
            }
          }
          if (task.files && task.files.length > 0) {
            console.log(chalk.dim(`    linked files (${task.files.length}):`));
            for (const f of task.files) {
              const fileUrl = f.url ?? `${process.env.VIBEFLOW_API_URL ?? "https://app.vibeflow.tools"}/api/tasks/${task.id}/files/${encodeURIComponent(f.name)}`;
              console.log(chalk.dim(`      - ${f.name}  ${fileUrl}`));
              // Use inlined content from the API response (no extra HTTP request needed).
              if (f.content) {
                console.log(chalk.dim(`        ┌── content ──`));
                for (const line of f.content.split("\n")) console.log(chalk.dim(`        │  ${line}`));
                console.log(chalk.dim(`        └─────────────`));
              }
            }
          }
          console.log();
        }

        const allForCount = saasData.tasks.map((t) => ({ ...t, status: toCliStatus(t.status) }));
        console.log(chalk.dim(formatStatusSummary(allForCount)));
      }
      return;
    }

    const all = listTasksWithPaths(dir);
    if (opts.user && !validateUserFilter(opts.user, all)) return;
    let filtered = opts.status ? all.filter((t) => t.status === opts.status) : all;
    if (opts.type) filtered = filtered.filter((t) => (t.type ?? 'Task').toLowerCase() === opts.type!.toLowerCase());
    if (opts.user) filtered = filtered.filter((t) => matchesUserFilter(t.author, opts.user!));
    if (opts.tag && opts.tag.length > 0) filtered = filtered.filter((t) => opts.tag!.every(tag => (t.tags ?? []).includes(tag)));

    const taskLimit = opts.limit !== undefined ? parseInt(opts.limit, 10) : 5;

    if (opts.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    filtered = filtered.sort((a, b) => {
      const byStatus = getStatusRank(a.status) - getStatusRank(b.status);
      if (byStatus !== 0) return byStatus;
      const byPriority = getPriorityRank(a.priority) - getPriorityRank(b.priority);
      if (byPriority !== 0) return byPriority;

      const aDate = new Date(a.updated ?? a.created).getTime();
      const bDate = new Date(b.updated ?? b.created).getTime();
      if (aDate !== bDate) return bDate - aDate;

      return a.id.localeCompare(b.id);
    });

    const totalFiltered = filtered.length;
    if (!isNaN(taskLimit) && taskLimit > 0) filtered = filtered.slice(0, taskLimit);

    if (filtered.length === 0) {
      console.log(chalk.dim("No tasks found."));
      return;
    }

    const projectDir = resolve(dir);

    const hasResearchTasks = filtered.some((t) =>
      (t.type ?? "").toLowerCase() === "research",
    );
    const hasBugTasks = filtered.some((t) =>
      (t.type ?? "").toLowerCase() === "bug",
    );

    const settings = loadSettings(projectDir);
    printAgentInstructions({ hasResearchTasks, hasBugTasks, autoCommit: settings.autoCommit, autoPush: settings.autoPush, autoComment: settings.autoComment, createBranch: settings.createBranch });

    const config = readConfig(projectDir);
    for (const [idx, task] of filtered.entries()) {
      const structuredComments = listComments(projectDir, task.id).sort(
        sortByCreatedAt,
      );
      const linkedFiles = listFiles(projectDir, task.id).map((f) => ({
        ...f,
        url: `http://localhost:${config.port}${f.url}`,
      }));
      const agent = formatTaskForAgent(task, structuredComments, linkedFiles);
      printTaskDetails(task, agent, idx, config.port, projectDir);
    }

    const limitSuffix = (!isNaN(taskLimit) && taskLimit > 0 && totalFiltered > taskLimit)
      ? chalk.yellow(` (showing ${taskLimit} of ${totalFiltered} matching — use --limit 0 for all)`)
      : "";
    console.log(chalk.dim(formatStatusSummary(all)) + limitSuffix);
    await flushTelemetry();
    })();
  });

// ── Auth commands (SaaS mode) ──────────────────────────────────────
program
  .command("login", { hidden: true })
  .description("Authenticate CLI against the Vibeflow SaaS backend (device flow)")
  .action(async () => {
    capture("command_run", { command: "login" });
    await flushTelemetry();
    await login();
  });

program
  .command("logout", { hidden: true })
  .description("Remove stored auth token and switch to local mode")
  .action(async () => {
    capture("command_run", { command: "logout" });
    await flushTelemetry();
    await logout();
  });

program
  .command("status", { hidden: true })
  .description("Show login status, connection info, and task statistics")
  .action(async () => {
    const mode = await getMode();

    if (mode === "local") {
      console.log(chalk.yellow("●  Not logged in") + chalk.dim("  (local mode)"));
      console.log(chalk.dim("  Run ") + chalk.cyan("vibeflow login") + chalk.dim(" to connect to the Vibeflow cloud."));
      console.log();

      const projectDir = resolve(".");
      const all = listTasksWithPaths(projectDir);
      if (all.length > 0) {
        const byStatus = all.reduce<Record<string, number>>((acc, t) => {
          acc[t.status] = (acc[t.status] ?? 0) + 1;
          return acc;
        }, {});
        console.log(chalk.bold("  Local task statistics:"));
        for (const [status, count] of Object.entries(byStatus)) {
          const colorFn = STATUS_COLORS[status] ?? chalk.white;
          console.log(`    ${colorFn(status.padEnd(12))} ${count}`);
        }
        console.log(chalk.dim(`    ${"total".padEnd(12)} ${all.length}`));
      } else {
        console.log(chalk.dim("  No local tasks found."));
      }
      return;
    }

    // SaaS mode
    const workspace = await readWorkspace();
    console.log(chalk.green("●  Online") + chalk.dim("  (SaaS mode)"));
    if (workspace) {
      console.log(chalk.dim(`  Board:   ${workspace.icon ? workspace.icon + " " : ""}${workspace.name}`));
      if (workspace.email) console.log(chalk.dim(`  Email:   ${workspace.email}`));
      console.log(chalk.dim(`  URL:     `) + chalk.cyan(workspace.url));
    }
    console.log();

    const saasData = await fetchSaasTasks(workspace?.id);
    if (!saasData) {
      console.log(chalk.yellow("  ⚠  Could not reach SaaS backend. Check your connection."));
      return;
    }

    const all = saasData.tasks.map((t) => ({ ...t, status: toCliStatus(t.status) }));
    if (all.length === 0) {
      console.log(chalk.dim("  No tasks found."));
      return;
    }

    const byStatus = all.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});

    console.log(chalk.bold("  Task statistics:"));
    for (const [status, count] of Object.entries(byStatus)) {
      const colorFn = STATUS_COLORS[status] ?? chalk.white;
      console.log(`    ${colorFn(status.padEnd(12))} ${count}`);
    }
    console.log(chalk.dim(`    ${"total".padEnd(12)} ${all.length}`));
  });

program
  .command("push", { hidden: true })
  .description("Push all local tasks to the Vibeflow SaaS app and delete them locally")
  .argument("[dir]", "Project root directory", ".")
  .option("--workspace <id>", "Target workspace ID (defaults to your first workspace)")
  .option("--keep-local-files", "Keep local task files after pushing (do not delete them)")
  .action(async (dir: string, opts: { workspace?: string; keepLocalFiles?: boolean }) => {
    capture("command_run", { command: "push" });
    await push(dir, opts);
    await flushTelemetry();
  });

program
  .command("telemetry")
  .description("Manage CLI usage telemetry (opt-out at any time)")
  .option("--enable", "Enable usage telemetry (default)")
  .option("--disable", "Disable usage telemetry")
  .option("--status", "Show current telemetry status")
  .action(async (opts: { enable?: boolean; disable?: boolean; status?: boolean }) => {
    if (opts.disable) {
      setTelemetryEnabled(false);
      console.log(chalk.yellow("Telemetry disabled. No usage data will be collected."));
      console.log(chalk.dim("Run `vibeflow telemetry --enable` to re-enable at any time."));
      return;
    }
    if (opts.enable) {
      setTelemetryEnabled(true);
      console.log(chalk.green("Telemetry enabled. Thank you for helping improve Vibeflow!"));
      return;
    }
    // Default: show status
    const { enabled, anonymousId } = getTelemetryStatus();
    const envOverride = process.env.VIBEFLOW_TELEMETRY === "0";
    console.log(chalk.bold("Telemetry status:"));
    console.log(`  Enabled: ${enabled ? chalk.green("yes") : chalk.yellow("no")}`);
    if (envOverride) {
      console.log(chalk.dim("  (disabled via VIBEFLOW_TELEMETRY=0 environment variable)"));
    }
    if (anonymousId) {
      console.log(chalk.dim(`  Anonymous ID: ${anonymousId}`));
    }
    console.log();
    console.log(chalk.dim("  vibeflow telemetry --disable   Opt out of usage tracking"));
    console.log(chalk.dim("  vibeflow telemetry --enable    Opt back in"));
    console.log(chalk.dim("  No PII is ever collected. User identity is hashed."));
  });

program.parse();
