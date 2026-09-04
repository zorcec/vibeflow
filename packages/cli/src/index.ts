import { Command } from "commander";
import { execSync, execFileSync } from "node:child_process";
import { serve } from "./server/server.js";
import {
  createTask,
  listTasks,
  listTasksWithPaths,
  updateTask,
  formatTaskForAgent,
  renderTaskForAgent,
  renderAgentInstructions,
  generateTaskId,
  ensureTaskDirs,
  findTaskFilePath,
  readTaskFile,
} from "./core/tasks.js";
import { listComments, addComment } from "./core/comments.js";
import { listFiles } from "./core/files.js";
import { readConfig } from "./core/config.js";
import { loadSettings } from "./core/settings.js";
import type { Task, TaskStatus } from "./core/types.js";
import { getMode } from "./auth/mode.js";
import { login, maybeRefreshSettings } from "./auth/login.js";
import { logout } from "./auth/logout.js";
import { push } from "./commands/push.js";
import { watch } from "./commands/watch.js";
import { showChangelog } from "./commands/changelog.js";
import { changelogText, readChangelogContent } from "./core/changelog.js";
import { clearAuthState, listAuthStateFiles } from "./commands/auth.js";
import { runVerify } from "./commands/verify.js";
import { runVerifyTool, VERIFY_TOOLS } from "./commands/verify-tools.js";
import {
  fetchSaasTasks,
  fetchSaasTask,
  updateSaasTask,
  addSaasComment,
  createSaasTask,
  toCliStatus,
} from "./saas/client.js";
import { readWorkspace } from "./auth/workspace.js";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import chalk from "chalk";
import {
  capture,
  flushTelemetry,
  setTelemetryEnabled,
  getTelemetryStatus,
} from "./telemetry.js";
import { ExitCode } from "./core/exit-codes.js";

// Injected at build time by tsup; undefined in raw TypeScript runs.
declare const __VIBEFLOW_CLI_VERSION__: string | undefined;

/** Compares semver strings; returns true if `latest` is strictly newer than `current`. */
function isNewerVersion(latest: string, current: string): boolean {
  const parts = (v: string) =>
    v
      .replace(/[^0-9.]/g, "")
      .split(".")
      .map(Number);
  const [la = 0, lb = 0, lc = 0] = parts(latest);
  const [ca = 0, cb = 0, cc = 0] = parts(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}

/** Guards the inline changelog so it prints at most once per process. */
let updateChangelogShown = false;

/**
 * Prints the latest CHANGELOG.md section below the update notice.
 * Silently tolerates a missing or unparseable changelog — the update notice
 * must never break because of it.
 */
function printUpdateChangelog(): void {
  if (updateChangelogShown) return;
  updateChangelogShown = true;
  try {
    const text = changelogText(readChangelogContent() ?? "");
    if (text) {
      console.log(text);
      console.log();
    }
  } catch {
    /* ignore — same never-throws contract as the update check */
  }
}

/**
 * Non-blocking npm update check. Fires an HTTPS request to the npm registry
 * and prints a visible notice when a newer version is available.
 * Never throws; all errors are silently swallowed.
 *
 * When `showChangelog` is true (default) the latest changelog section is
 * printed below the notice; pass false (via `--no-changelog`) to suppress it.
 */
function checkForUpdates(showChangelog = true): void {
  const current =
    typeof __VIBEFLOW_CLI_VERSION__ === "undefined"
      ? null
      : __VIBEFLOW_CLI_VERSION__;
  if (!current) return;
  const pkgName = "@vibeflow-tools/cli";
  import("node:https")
    .then(({ default: https }) => {
      const req = https.get(
        `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`,
        { timeout: 5000 },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on("end", () => {
            try {
              const { version: latest } = JSON.parse(body) as {
                version?: string;
              };
              if (latest && isNewerVersion(latest, current)) {
                console.log();
                console.log(
                  chalk.bgYellow.black.bold(
                    ` ↑ Update available: ${current} → ${latest} `,
                  ),
                );
                console.log(
                  chalk.dim("  Run: ") +
                    chalk.cyan(`npm install -g ${pkgName}@${latest}`) +
                    chalk.dim(" to update"),
                );
                console.log();
                if (showChangelog) printUpdateChangelog();
              }
            } catch {
              /* ignore parse errors */
            }
          });
        },
      );
      req.on("error", () => {
        /* ignore network errors */
      });
      req.on("timeout", () => {
        req.destroy();
      });
    })
    .catch(() => {
      /* ignore */
    });
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
const VALID_STATUSES = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
] as const;

/** Ascending comparator for objects with a `createdAt` ISO string field. */
const sortByCreatedAt = <T extends { createdAt: string }>(a: T, b: T): number =>
  new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

/** Returns the status count summary line (e.g. "Total: 10 | Backlog: 2 | Todo: 3 | ..."). */
function formatStatusSummary(tasks: { status: string }[]): string {
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  return `  Total: ${tasks.length} | Backlog: ${count("backlog")} | Todo: ${count("todo")} | In Progress: ${count("in-progress")} | Review: ${count("review")} | Done: ${count("done")}`;
}

/** Normalize task type: invalid or legacy values fall back to the generic "Task" type. */
function normalizeTaskType(
  type: string | undefined | null,
): string | undefined {
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
const KANBAN_STATUS_ORDER = [
  "in-progress",
  "review",
  "todo",
  "backlog",
  "done",
] as const;
function getStatusRank(status: string): number {
  const idx = KANBAN_STATUS_ORDER.indexOf(
    status as (typeof KANBAN_STATUS_ORDER)[number],
  );
  return idx === -1 ? KANBAN_STATUS_ORDER.length : idx;
}

function tryAutoPush(projectDir: string): { ok: boolean; error?: string } {
  try {
    execFileSync("git", ["push"], { cwd: projectDir, stdio: "inherit" });
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
        stdio: "inherit",
      });
      return { ok: true };
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      return { ok: false, error: msg.slice(0, 220) };
    }
  }
}

function printAgentInstructions(opts: {
  hasResearchTasks: boolean;
  hasBugTasks?: boolean;
  autoCommit?: boolean;
  autoPush?: boolean;
  autoComment?: boolean;
  createBranch?: boolean;
  requireVerifyBeforeReview?: boolean;
}) {
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
const VALID_FILTER_TYPES = [
  "Task",
  "Bug",
  "Feature",
  "Enhancement",
  "Research",
];

/** Returns next_actions hints for mutation commands based on the action performed. */
function getNextActions(
  action: "add" | "set-status:in-progress" | "set-status:review" | "commit",
  taskId?: string,
): string[] {
  switch (action) {
    case "add":
      return [
        "set status to in-progress before implementation",
        "add a description",
      ];
    case "set-status:in-progress":
      return [
        "implement the change",
        "run tests",
        `commit with vibeflow tasks --commit --task ${taskId} --message "..."`,
        "set review status",
      ];
    case "set-status:review":
      return ["only humans mark done after reviewing"];
    case "commit":
      return [
        'set review status with vibeflow tasks --edit <id> --set-status review --comment "what changed and why"',
      ];
  }
}

/** Picks only the specified fields from an object. If fields is empty, returns the object unchanged. */
function pickFields<T extends Record<string, unknown>>(
  obj: T,
  fields: string[],
): Partial<T> {
  if (fields.length === 0) return obj;
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in obj) result[f] = obj[f];
  }
  return result as Partial<T>;
}

/** Prints the → Next: hint line for human-readable output. */
function printNextHint(actions: string[]): void {
  const hint = actions.slice(0, 3).join(", ");
  console.log(chalk.cyan(`  → Next: ${hint}`));
}

/** Trim and lowercase a filter string for case-insensitive comparison. */
const normalizeFilterValue = (value: string): string =>
  value.trim().toLowerCase();

/**
 * Structured error output. In JSON mode, writes a machine-readable envelope
 * to stderr so stdout stays clean for piping. In human mode, writes to stderr
 * with chalk formatting.
 */
function outputError(opts: {
  code: string;
  message: string;
  retryable?: boolean;
  suggestion?: string;
  json?: boolean;
}): void {
  if (opts.json) {
    const envelope = {
      ok: false,
      error: {
        code: opts.code,
        message: opts.message,
        retryable: opts.retryable ?? false,
        ...(opts.suggestion ? { suggestion: opts.suggestion } : {}),
      },
    };
    process.stderr.write(JSON.stringify(envelope) + "\n");
  } else {
    process.stderr.write(chalk.red(`✗ ${opts.message}\n`));
    if (opts.suggestion) {
      process.stderr.write(chalk.dim(`  ${opts.suggestion}\n`));
    }
  }
}

/** True when `author` matches the user filter (case-insensitive). */
function matchesUserFilter(
  author: string | null | undefined,
  filter: string,
): boolean {
  const normalizedFilter = normalizeFilterValue(filter);
  if (!normalizedFilter) return true;
  return normalizeFilterValue(author ?? "") === normalizedFilter;
}

/** Returns sorted unique list of non-empty author strings from a task array. */
function collectAvailableUsers<T extends { author?: string | null }>(
  tasks: T[],
): string[] {
  return [
    ...new Set(
      tasks.map((t) => t.author?.trim()).filter((a): a is string => Boolean(a)),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** Validates --type filter value; logs error and sets exitCode if invalid. Returns true if valid. */
function validateTypeFilter(typeFilter: string): boolean {
  if (
    VALID_FILTER_TYPES.map((t) => t.toLowerCase()).includes(
      typeFilter.toLowerCase(),
    )
  )
    return true;
  console.log(chalk.red(`✗ Invalid type filter: "${typeFilter}"`));
  console.log(
    chalk.yellow(`  Available types: ${VALID_FILTER_TYPES.join(" | ")}`),
  );
  console.log(chalk.dim("  Type filter is exact (example: --type Bug)"));
  process.exitCode = ExitCode.USAGE;
  return false;
}

/** Validates --user filter value; logs error and sets exitCode if invalid. Returns true if valid. */
function validateUserFilter<T extends { author?: string | null }>(
  userFilter: string,
  tasks: T[],
): boolean {
  const availableUsers = collectAvailableUsers(tasks);
  if (availableUsers.length === 0) {
    console.log(
      chalk.red(
        `✗ Cannot filter by user: no task authors are available on this board.`,
      ),
    );
    process.exitCode = ExitCode.USAGE;
    return false;
  }
  if (availableUsers.some((author) => matchesUserFilter(author, userFilter)))
    return true;
  console.log(chalk.red(`✗ User not found: "${userFilter}"`));
  console.log(chalk.yellow(`  Available users: ${availableUsers.join(" | ")}`));
  console.log(
    chalk.dim("  User filter is exact email match (case-insensitive)."),
  );
  process.exitCode = ExitCode.USAGE;
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
  console.log(
    `  ${chalk.dim(`${idx + 1}.`)} ${colorFn(`[${agent.status}]`)} ${agent.title}`,
  );
  console.log(chalk.dim(`    id:       ${agent.id}`));
  console.log(chalk.dim(`    file:     ${task.filePath}`));
  if (agent.file)
    console.log(
      chalk.dim(
        `    source:   ${agent.file}${agent.line == null ? "" : `:${agent.line}`}${agent.col == null ? "" : `:${agent.col}`}`,
      ),
    );
  if (agent.component)
    console.log(chalk.dim(`    component: ${agent.component}`));
  console.log(chalk.dim(`    selector: ${agent.selector}`));
  if (task.cssSelector)
    console.log(chalk.dim(`    css:      ${task.cssSelector}`));
  if (agent.url) console.log(chalk.dim(`    url:      ${agent.url}`));
  if (task.screenshot)
    console.log(
      chalk.dim(
        `    screenshot: http://localhost:${port}/screenshots/${task.screenshot}`,
      ),
    );
  if (task.commits && task.commits.length > 0) {
    if (task.commits.length === 1) {
      console.log(chalk.dim(`    commit:   ${task.commits[0].sha}`));
    } else {
      console.log(chalk.dim(`    commits (${task.commits.length}):`));
      for (const c of task.commits) {
        console.log(
          chalk.dim(
            `      ${c.sha.slice(0, 8)}  ${c.timestamp}  ${c.message.slice(0, 60)}`,
          ),
        );
      }
    }
  }
  if (task.branchName)
    console.log(chalk.dim(`    branch:   ${task.branchName}`));
  console.log(chalk.dim(`    created:  ${agent.created}`));
  if (agent.type) console.log(chalk.dim(`    type:     ${agent.type}`));
  if (agent.priority) console.log(chalk.dim(`    priority: ${agent.priority}`));
  if (agent.description) {
    console.log(chalk.dim(`    description:`));
    for (const line of agent.description.split("\n"))
      console.log(chalk.dim(`      ${line}`));
  }
  if (agent.structuredComments && agent.structuredComments.length > 0) {
    console.log(
      chalk.dim(`    comments (${agent.structuredComments.length}):`),
    );
    for (const c of agent.structuredComments) {
      const edited = c.updatedAt ? ` (edited ${c.updatedAt})` : "";
      console.log(
        chalk.dim(`      [${c.author ?? "agent"}] ${c.createdAt}${edited}`),
      );
      for (const line of c.text.split("\n"))
        console.log(chalk.dim(`        ${line}`));
    }
  }
  if (agent.linkedFiles && agent.linkedFiles.length > 0) {
    console.log(chalk.dim(`    linked files (${agent.linkedFiles.length}):`));
    for (const f of agent.linkedFiles) {
      const absPath =
        f.linkedPath ?? join(projectDir, ".vibeflow", "files", task.id, f.name);
      console.log(chalk.dim(`      - ${f.name}  ${f.url}`));
      // Inline content for text/markdown files so agents have full context immediately.
      if (
        /\.(md|txt)$/i.test(f.name) &&
        f.size < 100_000 &&
        existsSync(absPath)
      ) {
        try {
          const content = readFileSync(absPath, "utf-8");
          console.log(chalk.dim(`        ┌── content ──`));
          for (const line of content.split("\n"))
            console.log(chalk.dim(`        │  ${line}`));
          console.log(chalk.dim(`        └─────────────`));
        } catch {
          /* file not readable — URL shown above */
        }
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
  .version(
    typeof __VIBEFLOW_CLI_VERSION__ === "undefined"
      ? "0.0.0"
      : __VIBEFLOW_CLI_VERSION__,
  );

program.addHelpText(
  "after",
  `
${"─".repeat(60)}
For coding agents — quick reference:

  vibeflow tasks                       List all tasks
  vibeflow tasks --status todo         Filter to open tasks
  vibeflow tasks --tag <tag>           Filter by tag (repeatable for AND)
  vibeflow tasks --get <id>            Full task details
  vibeflow tasks --next                Pick highest-priority todo task (auto-claims)
  vibeflow tasks --edit <id> --set-status in-progress
  vibeflow serve [target]              Start local server / prototype viewer
  vibeflow kanban                      Open the Kanban board in browser
  vibeflow watch [dir]                 Watch task store; print new + moved-to-todo tickets
  vibeflow changelog [--all]           Show the changelog (latest version / all versions)

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
    POST /api/tasks/<id>/files/<filename>
    Content-Type: application/octet-stream
    <file binary body>
  List:   GET  /api/tasks/<id>/files
  Delete: DELETE /api/tasks/<id>/files/<filename>
`,
);

program
  .command("serve")
  .description(
    "Serve HTML prototype(s) with live overlay, or start API-only task server for existing apps",
  )
  .argument("[target]", "HTML file or directory of HTML files")
  .option("-p, --port <port>", "Port number", "3700")
  .option(
    "--host <host>",
    "Bind hostname (default: localhost; use 0.0.0.0 for LAN sharing)",
  )
  .option("--no-open", "Do not open browser automatically")
  .action(
    async (
      target: string | undefined,
      opts: { port: string; open: boolean; host?: string },
    ) => {
      capture("command_run", { command: "serve" });
      await flushTelemetry();
      await serve(target, {
        port: parseInt(opts.port, 10),
        host: opts.host,
        open: opts.open,
      });
    },
  );

program
  .command("kanban")
  .description(
    "Start the Vibeflow server and open the live Kanban board in the browser",
  )
  .argument("[dir]", "Project root directory", ".")
  .option("-p, --port <port>", "Port number", "3700")
  .option(
    "--host <host>",
    "Bind hostname (default: localhost; use 0.0.0.0 for LAN sharing)",
  )
  .option("--no-open", "Do not open browser automatically")
  .option("--no-changelog", "Do not show the changelog with the update notice")
  .action(
    async (
      dir: string,
      opts: { port: string; host?: string; open: boolean; changelog: boolean },
    ) => {
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
      if (instance.localUrl) {
        console.log(
          chalk.dim("    ") + chalk.cyan(`${instance.localUrl}/kanban`),
        );
      }
      console.log();
      console.log(chalk.bold("Agent prompt:"));
      console.log(
        chalk.dim(
          "  Get new tasks and implement them, once done check again for new ones:",
        ),
      );
      console.log(
        chalk.dim("  ") + chalk.green(`npx @vibeflow-tools/cli tasks --next`),
      );
      console.log();
      console.log(chalk.dim("  Press Ctrl+C to stop"));
      console.log();
      if (opts.open) {
        import("open")
          .then((mod) => mod.default(kanbanUrl))
          .catch(() => {
            console.log(chalk.dim("  Visit: ") + chalk.cyan(kanbanUrl));
          });
      }
      // Non-blocking update check — runs after all startup output is shown.
      void checkForUpdates(opts.changelog !== false);
    },
  );

program
  .command("tasks")
  .description("List or edit tasks in the project")
  .argument("[dir]", "Project root directory", ".")
  .option(
    "--status <status>",
    "Filter by status (backlog, todo, in-progress, review, done)",
  )
  .option(
    "--type <type>",
    "Filter by type (Task, Bug, Feature, Enhancement, Research)",
  )
  .option(
    "--user <user>",
    "Filter by exact task author email (case-insensitive)",
  )
  .option(
    "--edit [task-id]",
    "Edit a task by ID (LLM-friendly). Omit task-id to see usage instructions.",
  )
  .option("--add", "Create a task (requires --title)")
  .option("--title <title>", "New title for the task (use with --edit)")
  .option(
    "--set-status <status>",
    "New status: backlog | todo | in-progress | review | done (use with --edit)",
  )
  .option(
    "--description <text>",
    "New description for the task (use with --edit)",
  )
  .option("--json", "Output machine-readable JSON")
  .option(
    "--commit",
    "Commit staged changes and link the commit SHA to a task (use with --task)",
  )
  .option(
    "--task <task-id>",
    "Task ID to link with the commit (use with --commit)",
  )
  .option(
    "--message <msg>",
    "Commit message (use with --commit; task ID is appended automatically)",
  )
  .option(
    "--comment <text>",
    "Implementation report comment (required when setting status to review)",
  )
  .option(
    "--commit-message <msg>",
    "Commit message for auto-commit on review (required when auto-commit setting is ON)",
  )
  .option(
    "--get <task-id>",
    "Get full details of a single task by ID (supports partial ID prefix)",
  )
  .option(
    "--next",
    "Pick the next available todo task, move it to in-progress, and output it ready to work on",
  )
  .option(
    "--tag <tag>",
    "Filter by tag (can be specified multiple times for AND matching)",
    (val, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--report-file <path>",
    "Path to a local .md file to upload as the research report (use with --set-status review on Research tasks; file is uploaded and deleted locally)",
  )
  .option(
    "--branch <name>",
    "Git branch name for the task (required when createBranch setting is ON and setting status to review)",
  )
  .option(
    "--skip-verify",
    "Skip the verify-before-review gate (for non-UI tasks, the gate is automatically skipped)",
  )
  .option(
    "--limit <n>",
    "Limit how many tasks are returned in list mode (default: 5; use 0 for unlimited)",
  )
  .option(
    "--dry-run",
    "Preview what would change without modifying anything (mutations only)",
  )
  .option(
    "--fields <fields>",
    "Comma-separated list of fields to include in output (list/get modes)",
  )
  .option(
    "--priority <priority>",
    "Task priority (Critical, High, Medium, Low) — use with --add",
  )
  .action(
    (
      dir: string,
      opts: {
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
        dryRun?: boolean;
        fields?: string;
        skipVerify?: boolean;
        priority?: string;
      },
    ) => {
      async function runTasks() {
        // Determine sub-command for telemetry before async operations
        const taskSubcommand = opts.add
          ? "add"
          : opts.next
            ? "next"
            : opts.edit
              ? "edit"
              : opts.get
                ? "get"
                : "list";
        capture("command_run", {
          command: "tasks",
          subcommand: taskSubcommand,
        });

        // ── Get single task mode ───────────────────────────────────────────
        if (opts.get) {
          const getTaskMode = await getMode();
          if (getTaskMode === "saas") {
            const workspace = await readWorkspace();
            const saasData = await fetchSaasTasks(workspace?.id);
            if (!saasData) {
              console.log(chalk.red("✗ Unable to reach the online backend."));
              process.exitCode = ExitCode.GENERAL;
              return;
            }
            const saasTask = saasData.tasks.find(
              (t) => t.id === opts.get || t.id.startsWith(opts.get!),
            );
            if (!saasTask) {
              console.log(chalk.red(`✗ Task not found: ${opts.get}`));
              process.exitCode = ExitCode.NOT_FOUND;
              return;
            }
            const cliStatus = toCliStatus(saasTask.status);
            if (opts.json) {
              console.log(
                JSON.stringify({ ...saasTask, status: cliStatus }, null, 2),
              );
              return;
            }
            const colorFnSaas = STATUS_COLORS[cliStatus] ?? chalk.white;
            console.log(
              `  ${colorFnSaas(`[${cliStatus}]`)} ${chalk.bold(saasTask.title)}`,
            );
            console.log(chalk.dim(`    id:       ${saasTask.id}`));
            console.log(chalk.dim(`    selector: /`));
            if (saasTask.type)
              console.log(chalk.dim(`    type:     ${saasTask.type}`));
            if (saasTask.priority)
              console.log(chalk.dim(`    priority: ${saasTask.priority}`));
            console.log(chalk.dim(`    created:  ${saasTask.createdAt}`));
            if (saasTask.description) {
              console.log(chalk.dim(`    description:`));
              for (const line of saasTask.description.split("\n"))
                console.log(chalk.dim(`      ${line}`));
            }
            if (saasTask.annotatedElementText) {
              console.log(
                chalk.dim(`    element text: ${saasTask.annotatedElementText}`),
              );
            }
            if (saasTask.branchName)
              console.log(chalk.dim(`    branch:   ${saasTask.branchName}`));
            const saasComments = [...(saasTask.comments ?? [])].sort(
              sortByCreatedAt,
            );
            if (saasComments.length > 0) {
              console.log(chalk.dim(`    comments (${saasComments.length}):`));
              for (const c of saasComments) {
                console.log(
                  chalk.dim(
                    `      [${(c as { author?: string }).author ?? "agent"}] ${c.createdAt}`,
                  ),
                );
                for (const line of c.body.split("\n"))
                  console.log(chalk.dim(`        ${line}`));
              }
            }
            if (saasTask.files && saasTask.files.length > 0) {
              console.log(
                chalk.dim(`    linked files (${saasTask.files.length}):`),
              );
              for (const f of saasTask.files) {
                const fileUrl =
                  f.url ??
                  `${process.env.VIBEFLOW_API_URL ?? "https://app.vibeflow.tools"}/api/tasks/${saasTask.id}/files/${encodeURIComponent(f.name)}`;
                console.log(chalk.dim(`      - ${f.name}  ${fileUrl}`));
                if (f.content) {
                  console.log(chalk.dim(`        ┌── content ──`));
                  for (const line of f.content.split("\n"))
                    console.log(chalk.dim(`        │  ${line}`));
                  console.log(chalk.dim(`        └─────────────`));
                }
              }
            }
            const saasGetSettings = loadSettings(resolve(dir));
            const isResearch =
              (saasTask.type ?? "").toLowerCase() === "research";
            const isBug = (saasTask.type ?? "").toLowerCase() === "bug";
            printAgentInstructions({
              hasResearchTasks: isResearch,
              hasBugTasks: isBug,
              autoCommit: saasGetSettings.autoCommit,
              autoPush: saasGetSettings.autoPush,
              autoComment: saasGetSettings.autoComment,
              createBranch: saasGetSettings.createBranch,
              requireVerifyBeforeReview:
                saasGetSettings.requireVerifyBeforeReview,
            });
            return;
          }

          // ── Local mode ──
          const projectDir = resolve(dir);
          const config = readConfig(projectDir);
          const allWithPaths = listTasksWithPaths(projectDir);
          const task = allWithPaths.find(
            (t) => t.id === opts.get || t.id.startsWith(opts.get!),
          );
          if (!task) {
            outputError({
              code: "E_NOT_FOUND",
              message: `Task not found: ${opts.get}`,
              suggestion: "Run 'vibeflow tasks' to see available task IDs.",
              json: opts.json,
            });
            process.exitCode = ExitCode.NOT_FOUND;
            return;
          }
          const structuredComments = listComments(projectDir, task.id).sort(
            sortByCreatedAt,
          );
          const linkedFiles = listFiles(projectDir, task.id).map((f) => ({
            ...f,
            url: `http://localhost:${config.port}${f.url}`,
          }));
          if (opts.json) {
            const getFields = opts.fields
              ? opts.fields
                  .split(",")
                  .map((f: string) => f.trim())
                  .filter(Boolean)
              : [];
            // SAFETY: Task + comments + files are plain JSON-serializable objects; Record<string, unknown> is the superset for field picking.
            console.log(
              JSON.stringify(
                pickFields(
                  {
                    ...task,
                    comments: structuredComments,
                    files: linkedFiles,
                  } as unknown as Record<string, unknown>,
                  getFields,
                ),
                null,
                2,
              ),
            );
            return;
          }
          const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
          const agentMessage = renderTaskForAgent(
            task,
            task.filePath,
            structuredComments,
            linkedFiles,
            projectDir,
          );
          // Prepend the colored status/title line, then print the rest dimmed
          const agentLines = agentMessage.split("\n");
          if (agentLines.length > 0) {
            const firstLine = agentLines[0];
            const match = firstLine.match(/^\[(\w+)\]\s+(.+)$/);
            if (match) {
              console.log(
                `  ${colorFn(`[${match[1]}]`)} ${chalk.bold(match[2])}`,
              );
            } else {
              console.log(chalk.dim(firstLine));
            }
            for (let i = 1; i < agentLines.length; i++) {
              console.log(chalk.dim(agentLines[i]));
            }
          }
          const localGetSettings = loadSettings(projectDir);
          const isLocalResearch =
            (task.type ?? "").toLowerCase() === "research";
          const isLocalBug = (task.type ?? "").toLowerCase() === "bug";
          printAgentInstructions({
            hasResearchTasks: isLocalResearch,
            hasBugTasks: isLocalBug,
            autoCommit: localGetSettings.autoCommit,
            autoPush: localGetSettings.autoPush,
            autoComment: localGetSettings.autoComment,
            createBranch: localGetSettings.createBranch,
            requireVerifyBeforeReview:
              localGetSettings.requireVerifyBeforeReview,
          });
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
              process.exitCode = ExitCode.GENERAL;
              return;
            }
            if (opts.type && !validateTypeFilter(opts.type)) return;
            let todoTasks = saasData.tasks
              .map((t) => ({ ...t, status: toCliStatus(t.status) }))
              .filter((t) => t.status === "todo");
            if (opts.type)
              todoTasks = todoTasks.filter(
                (t) =>
                  (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase(),
              );
            if (opts.user && !validateUserFilter(opts.user, todoTasks)) return;
            if (opts.user)
              todoTasks = todoTasks.filter((t) =>
                matchesUserFilter(t.author, opts.user!),
              );
            if (opts.tag && opts.tag.length > 0)
              todoTasks = todoTasks.filter((t) =>
                opts.tag!.every((tag) =>
                  ((t as { tags?: string[] }).tags ?? []).includes(tag),
                ),
              );
            todoTasks = todoTasks.sort((a, b) => {
              const byPriority =
                getPriorityRank(a.priority ?? undefined) -
                getPriorityRank(b.priority ?? undefined);
              if (byPriority !== 0) return byPriority;
              return sortByCreatedAt(a, b);
            });

            if (todoTasks.length === 0) {
              const filterHints = [
                opts.type && `type=${opts.type}`,
                opts.user && `user=${opts.user}`,
                opts.tag?.length && `tag=${opts.tag.join(",")}`,
              ].filter(Boolean);
              const suffix =
                filterHints.length > 0
                  ? ` matching ${filterHints.join(" ")}`
                  : "";
              console.log(
                chalk.dim(`No todo tasks found${suffix}. Nothing to work on.`),
              );
              return;
            }

            const nextTask = todoTasks[0];
            const updated = await updateSaasTask(nextTask.id, {
              status: "in-progress",
            });
            if (!updated) {
              console.log(
                chalk.red(
                  `✗ Failed to move task to in-progress: ${nextTask.id}`,
                ),
              );
              process.exitCode = ExitCode.GENERAL;
              return;
            }

            const nextSaasNextActions = getNextActions(
              "set-status:in-progress",
              nextTask.id,
            );
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    success: true,
                    task: { ...nextTask, status: "in-progress" },
                    next_actions: nextSaasNextActions,
                  },
                  null,
                  2,
                ),
              );
              return;
            }

            const nextSettings = loadSettings(resolve(dir));
            const isResearch =
              (nextTask.type ?? "").toLowerCase() === "research";
            const isBug = (nextTask.type ?? "").toLowerCase() === "bug";
            printAgentInstructions({
              hasResearchTasks: isResearch,
              hasBugTasks: isBug,
              autoCommit: nextSettings.autoCommit,
              autoPush: nextSettings.autoPush,
              autoComment: nextSettings.autoComment,
              createBranch: nextSettings.createBranch,
              requireVerifyBeforeReview: nextSettings.requireVerifyBeforeReview,
            });

            console.log(
              chalk.green.bold(
                "▶ NEXT TASK — Status moved to in-progress. Implement this now:",
              ),
            );
            console.log();
            console.log(
              `  ${chalk.blue(`[in-progress]`)} ${chalk.bold(nextTask.title)}`,
            );
            console.log(chalk.dim(`    id:       ${nextTask.id}`));
            if (nextTask.type)
              console.log(chalk.dim(`    type:     ${nextTask.type}`));
            if (nextTask.priority)
              console.log(chalk.dim(`    priority: ${nextTask.priority}`));
            console.log(chalk.dim(`    created:  ${nextTask.createdAt}`));
            if (nextTask.description) {
              console.log(chalk.dim(`    description:`));
              for (const line of nextTask.description.split("\n"))
                console.log(chalk.dim(`      ${line}`));
            }
            const sortedNextComments = [...(nextTask.comments ?? [])].sort(
              sortByCreatedAt,
            );
            if (sortedNextComments.length > 0) {
              console.log(
                chalk.dim(`    comments (${sortedNextComments.length}):`),
              );
              for (const c of sortedNextComments) {
                const author = (c as { authorId?: string }).authorId
                  ? `user:${(c as { authorId?: string }).authorId!.slice(0, 8)}`
                  : "agent";
                console.log(chalk.dim(`      [${author}] ${c.createdAt}`));
                for (const line of c.body.split("\n"))
                  console.log(chalk.dim(`        ${line}`));
              }
            }
            console.log();
            console.log(
              chalk.yellow(
                "  ⚡ This task is already in-progress. Implement it now and mark as review when done.",
              ),
            );
            printNextHint(nextSaasNextActions);
            return;
          }

          // ── Local next mode ──────────────────────────────────────────────
          const nextProjectDir = resolve(dir);
          const allTasks = listTasksWithPaths(nextProjectDir);
          if (opts.type && !validateTypeFilter(opts.type)) return;
          let todoList = allTasks.filter((t) => t.status === "todo");
          if (opts.type)
            todoList = todoList.filter(
              (t) =>
                (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase(),
            );
          if (opts.user && !validateUserFilter(opts.user, todoList)) return;
          if (opts.user)
            todoList = todoList.filter((t) =>
              matchesUserFilter(t.author, opts.user!),
            );
          if (opts.tag && opts.tag.length > 0)
            todoList = todoList.filter((t) =>
              opts.tag!.every((tag) => (t.tags ?? []).includes(tag)),
            );
          todoList = todoList.sort((a, b) => {
            const byPriority =
              getPriorityRank(a.priority) - getPriorityRank(b.priority);
            if (byPriority !== 0) return byPriority;
            return (
              new Date(a.created).getTime() - new Date(b.created).getTime()
            );
          });

          if (todoList.length === 0) {
            const filterHints = [
              opts.type && `type=${opts.type}`,
              opts.user && `user=${opts.user}`,
              opts.tag?.length && `tag=${opts.tag.join(",")}`,
            ].filter(Boolean);
            const suffix =
              filterHints.length > 0
                ? ` matching ${filterHints.join(" ")}`
                : "";
            console.log(
              chalk.dim(`No todo tasks found${suffix}. Nothing to work on.`),
            );
            return;
          }

          const nextLocalTask = todoList[0];
          const nextUpdated = updateTask(nextProjectDir, nextLocalTask.id, {
            status: "in-progress",
          });
          if (!nextUpdated) {
            console.log(
              chalk.red(`✗ Failed to update task: ${nextLocalTask.id}`),
            );
            process.exitCode = ExitCode.GENERAL;
            return;
          }

          const nextLocalNextActions = getNextActions(
            "set-status:in-progress",
            nextUpdated.id,
          );
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  task: { ...nextUpdated, filePath: nextLocalTask.filePath },
                  next_actions: nextLocalNextActions,
                },
                null,
                2,
              ),
            );
            return;
          }

          const nextLocalSettings = loadSettings(nextProjectDir);
          const isLocalNextResearch =
            (nextUpdated.type ?? "").toLowerCase() === "research";
          const isLocalNextBug =
            (nextUpdated.type ?? "").toLowerCase() === "bug";
          printAgentInstructions({
            hasResearchTasks: isLocalNextResearch,
            hasBugTasks: isLocalNextBug,
            autoCommit: nextLocalSettings.autoCommit,
            autoPush: nextLocalSettings.autoPush,
            autoComment: nextLocalSettings.autoComment,
            createBranch: nextLocalSettings.createBranch,
            requireVerifyBeforeReview:
              nextLocalSettings.requireVerifyBeforeReview,
          });

          const config = readConfig(nextProjectDir);
          const structuredComments = listComments(
            nextProjectDir,
            nextUpdated.id,
          ).sort(sortByCreatedAt);
          const linkedFiles = listFiles(nextProjectDir, nextUpdated.id).map(
            (f) => ({
              ...f,
              url: `http://localhost:${config.port}${f.url}`,
            }),
          );
          const agentMessage = renderTaskForAgent(
            nextUpdated,
            nextLocalTask.filePath,
            structuredComments,
            linkedFiles,
            nextProjectDir,
          );

          console.log(
            chalk.green.bold(
              "▶ NEXT TASK — Status moved to in-progress. Implement this now:",
            ),
          );
          console.log();
          const agentLines = agentMessage.split("\n");
          if (agentLines.length > 0) {
            const match = agentLines[0].match(/^\[(\w+)\]\s+(.+)$/);
            if (match) {
              console.log(
                `  ${chalk.blue(`[${match[1]}]`)} ${chalk.bold(match[2])}`,
              );
            } else {
              console.log(chalk.dim(agentLines[0]));
            }
            for (let i = 1; i < agentLines.length; i++) {
              console.log(chalk.dim(agentLines[i]));
            }
          }
          console.log();
          console.log(
            chalk.yellow(
              "  ⚡ This task is already in-progress. Implement it now and mark as review when done.",
            ),
          );
          printNextHint(nextLocalNextActions);
          return;
        }

        // ── Add mode ───────────────────────────────────────────────────────
        if (opts.add) {
          if (!opts.title?.trim()) {
            outputError({
              code: "E_USAGE",
              message: "--title is required with --add",
              suggestion:
                'Example: vibeflow tasks --add --title "Fix CTA spacing" --description "Button overflows on mobile"',
              json: opts.json,
            });
            process.exitCode = ExitCode.USAGE;
            return;
          }

          const addMode = await getMode();
          if (addMode === "saas") {
            const addWorkspace = await readWorkspace();
            const validSaasStatuses = [
              "backlog",
              "todo",
              "in-progress",
              "review",
              "done",
            ];
            const saasStatus = validSaasStatuses.includes(opts.setStatus ?? "")
              ? opts.setStatus
              : "todo";
            const newId = generateTaskId();
            if (opts.dryRun) {
              const dryTask = {
                id: newId,
                title: opts.title.trim(),
                description: opts.description?.trim() ?? "",
                status: saasStatus,
                boardId: addWorkspace?.id,
              };
              if (opts.json) {
                console.log(
                  JSON.stringify(
                    {
                      dryRun: true,
                      action: "create",
                      task: dryTask,
                      next_actions: getNextActions("add", newId),
                    },
                    null,
                    2,
                  ),
                );
              } else {
                console.log(chalk.yellow("  [dry-run] Would create task:"));
                console.log(chalk.dim(`    title:  ${dryTask.title}`));
                console.log(chalk.dim(`    status: ${dryTask.status}`));
                if (dryTask.description)
                  console.log(
                    chalk.dim(`    description: ${dryTask.description}`),
                  );
                printNextHint(getNextActions("add", newId));
              }
              return;
            }
            const saasCreated = await createSaasTask({
              id: newId,
              title: opts.title.trim(),
              description: opts.description?.trim(),
              status: saasStatus,
              boardId: addWorkspace?.id,
            });
            if (!saasCreated) {
              console.log(
                chalk.red("✗ Failed to create task in online board."),
              );
              console.log(
                chalk.yellow(
                  "  Check your connection or run 'vibeflow login'.",
                ),
              );
              process.exitCode = ExitCode.GENERAL;
              return;
            }
            const addNextActions = getNextActions("add", saasCreated.id);
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    success: true,
                    task: saasCreated,
                    next_actions: addNextActions,
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(chalk.green(`✓ Task created: ${saasCreated.title}`));
              console.log(
                chalk.dim(
                  `  id: ${saasCreated.id} | status: ${toCliStatus(saasCreated.status)}`,
                ),
              );
              printNextHint(addNextActions);
            }
            return;
          }

          const projectDir = resolve(dir);
          ensureTaskDirs(projectDir);
          const validStatuses = [
            "backlog",
            "todo",
            "in-progress",
            "review",
            "done",
          ];
          const status = validStatuses.includes(opts.setStatus ?? "")
            ? (opts.setStatus as TaskStatus)
            : "todo";

          if (opts.dryRun) {
            const dryId = generateTaskId();
            const dryTask = {
              id: dryId,
              title: opts.title.trim(),
              description: opts.description?.trim() ?? "",
              status,
              selector: "/",
            };
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    dryRun: true,
                    action: "create",
                    task: dryTask,
                    next_actions: getNextActions("add", dryId),
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(chalk.yellow("  [dry-run] Would create task:"));
              console.log(chalk.dim(`    title:  ${dryTask.title}`));
              console.log(chalk.dim(`    status: ${dryTask.status}`));
              if (dryTask.description)
                console.log(
                  chalk.dim(`    description: ${dryTask.description}`),
                );
              printNextHint(getNextActions("add", dryId));
            }
            return;
          }

          const created = createTask(projectDir, {
            title: opts.title.trim(),
            description: opts.description?.trim() ?? "",
            status,
            selector: "/",
            ...(opts.type ? { type: opts.type } : {}),
            ...(opts.priority ? { priority: opts.priority } : {}),
            ...(opts.tag?.length ? { tags: opts.tag } : {}),
          });

          const localAddNextActions = getNextActions("add", created.id);
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  task: created,
                  next_actions: localAddNextActions,
                },
                null,
                2,
              ),
            );
          } else {
            console.log(chalk.green(`✓ Task created: ${created.title}`));
            console.log(
              chalk.dim(`  id: ${created.id} | status: ${created.status}`),
            );
            printNextHint(localAddNextActions);
          }
          return;
        }

        // ── Commit mode ────────────────────────────────────────────────────
        if (opts.commit) {
          if (!opts.task) {
            outputError({
              code: "E_USAGE",
              message: "--task <task-id> is required with --commit",
              suggestion:
                'Example: vibeflow tasks --commit --task abc12345 --message "fix button alignment"',
              json: opts.json,
            });
            process.exitCode = ExitCode.USAGE;
            return;
          }
          const projectDir = resolve(dir);
          const tasks = listTasks(projectDir);
          const task = tasks.find(
            (t) => t.id === opts.task || t.id.startsWith(opts.task!),
          );
          if (!task) {
            outputError({
              code: "E_NOT_FOUND",
              message: `Task not found: ${opts.task}`,
              suggestion: "Run 'vibeflow tasks' to see available task IDs.",
              json: opts.json,
            });
            process.exitCode = ExitCode.NOT_FOUND;
            return;
          }
          const baseMsg = opts.message?.trim() || task.title;
          if (opts.dryRun) {
            const commitMsg = `${baseMsg} [proto:${task.id}]`;
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    dryRun: true,
                    action: "commit",
                    message: commitMsg,
                    taskId: task.id,
                    next_actions: getNextActions("commit", task.id),
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(chalk.yellow("  [dry-run] Would commit:"));
              console.log(chalk.dim(`    message: ${commitMsg}`));
              console.log(chalk.dim(`    task:    ${task.id}`));
              printNextHint(getNextActions("commit", task.id));
            }
            return;
          }
          // Warn when committing for a Research task — code changes should not be made.
          if ((task.type ?? "").toLowerCase() === "research") {
            console.log(
              chalk.yellow(
                "⚠  WARNING: This is a Research task. Research tasks must NOT produce code changes.",
              ),
            );
            console.log(
              chalk.yellow(
                "   Only commit research report files (.md). Do not commit code changes.",
              ),
            );
            console.log();
          }
          const commitMsg = `${baseMsg} [proto:${task.id}]`;
          try {
            execFileSync("git", ["commit", "-m", commitMsg], {
              cwd: projectDir,
              stdio: "inherit",
            });
            const sha = execSync("git rev-parse HEAD", { cwd: projectDir })
              .toString()
              .trim();
            const commitRecord = {
              sha,
              message: baseMsg,
              timestamp: new Date().toISOString(),
            };
            const existingCommits = task.commits ?? [];
            updateTask(projectDir, task.id, {
              commits: [...existingCommits, commitRecord],
            });
            const commitNextActions = getNextActions("commit", task.id);
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    success: true,
                    commit: sha,
                    next_actions: commitNextActions,
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(
                chalk.green(`✓ Committed and linked to task: ${task.title}`),
              );
              console.log(chalk.dim(`  commit: ${sha}`));
              console.log(chalk.dim(`  proto:  ${task.id}`));
              printNextHint(commitNextActions);
            }

            const settings = loadSettings(projectDir);
            if (settings.autoPush) {
              console.log(
                chalk.dim("  auto-push: pushing commit to remote..."),
              );
              const pushed = tryAutoPush(projectDir);
              if (pushed.ok) {
                console.log(chalk.green("✓ Auto-push complete"));
              } else {
                console.log(
                  chalk.yellow(
                    "⚠ Auto-push failed. Commit is local; run 'git push' manually.",
                  ),
                );
                if (pushed.error) {
                  console.log(chalk.dim(`  reason: ${pushed.error}`));
                }
              }
            }
          } catch {
            console.log(
              chalk.red(
                "✗ git commit failed — ensure changes are staged with 'git add'",
              ),
            );
            process.exitCode = ExitCode.GENERAL;
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
            if (opts.type)
              all = all.filter(
                (t) =>
                  (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase(),
              );
            if (opts.user && !validateUserFilter(opts.user, all)) return;
            if (opts.user)
              all = all.filter((t) => matchesUserFilter(t.author, opts.user!));
            if (opts.tag && opts.tag.length > 0)
              all = all.filter((t) =>
                opts.tag!.every((tag) => (t.tags ?? []).includes(tag)),
              );
            console.log(
              chalk.bold("vibeflow tasks --edit — LLM Usage Instructions"),
            );
            console.log();
            console.log("Edit a task:");
            console.log(
              chalk.cyan(
                '  vibeflow tasks [dir] --edit <task-id> [--title "new title"] [--set-status backlog|todo|in-progress|review|done] [--description "new description"]',
              ),
            );
            console.log();
            console.log("Examples:");
            console.log(
              chalk.dim("  vibeflow tasks --edit abc12345 --set-status done"),
            );
            console.log(
              chalk.dim(
                "  vibeflow tasks --edit abc12345 --set-status in-progress",
              ),
            );
            console.log(
              chalk.dim(
                '  vibeflow tasks --edit abc12345 --title "Updated title" --description "More detail"',
              ),
            );
            console.log();
            if (all.length === 0) {
              console.log(chalk.dim("No tasks found."));
            } else {
              console.log("Available tasks:");
              for (const task of all) {
                const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
                console.log(
                  `  ${colorFn(`[${task.status}]`)} ${chalk.bold(task.id)} — ${task.title}`,
                );
              }
            }
            return;
          }

          if (opts.setStatus === "done") {
            console.log(
              chalk.yellow(
                '⚠ WARNING: Agents should NEVER set a task status to "done".',
              ),
            );
            console.log(
              chalk.yellow(
                "  Only humans should mark tasks as done after reviewing.",
              ),
            );
            console.log(
              chalk.dim(
                "  If you are an agent, use --set-status review instead.",
              ),
            );
            console.log();
          }

          if (
            opts.setStatus &&
            !VALID_STATUSES.includes(
              opts.setStatus as (typeof VALID_STATUSES)[number],
            )
          ) {
            console.log(chalk.red(`✗ Invalid status: "${opts.setStatus}"`));
            console.log(
              chalk.yellow(`  Valid statuses: ${VALID_STATUSES.join(" | ")}`),
            );
            console.log(
              chalk.dim(
                `  Example: vibeflow tasks --edit ${taskId} --set-status in-progress`,
              ),
            );
            process.exitCode = ExitCode.USAGE;
            return;
          }

          if (opts.setStatus === "review" && !opts.comment?.trim()) {
            console.log(
              chalk.red(
                "✗ --comment is required when setting status to review",
              ),
            );
            console.log(
              chalk.dim(
                "  Provide a concise implementation report explaining:",
              ),
            );
            console.log(chalk.dim("    · what was changed and why"));
            console.log(chalk.dim("    · key decisions and trade-offs"));
            console.log(chalk.dim("    · anything future agents should know"));
            console.log(
              chalk.dim(
                `  Example: vibeflow tasks --edit ${taskId} --set-status review --comment "Implemented X by doing Y. Key decision: Z."`,
              ),
            );
            process.exitCode = ExitCode.USAGE;
            return;
          }

          // ── Settings-based enforcement on review ─────────────────────────
          const editMode = await getMode();
          const projectDir = resolve(dir);
          const settings = loadSettings(projectDir);
          if (opts.setStatus === "review") {
            // Enforce --comment when autoComment is ON
            if (settings.autoComment && !opts.comment?.trim()) {
              console.log(
                chalk.red(
                  "✗ --comment is required (auto-comment setting is ON)",
                ),
              );
              console.log(
                chalk.dim(
                  "  Provide: what changed, why, key decisions, anything future agents should know.",
                ),
              );
              console.log(
                chalk.dim(
                  "  Plain text for short notes; Markdown for multi-section reports.",
                ),
              );
              console.log(
                chalk.dim(
                  `  Example: vibeflow tasks --edit ${taskId} --set-status review --comment "Implemented X by doing Y."`,
                ),
              );
              process.exitCode = ExitCode.USAGE;
              return;
            }

            // Validate --commit-message presence when autoCommit is ON.
            // The actual git commit runs after task status + comment are saved so that
            // a commit failure never prevents the comment from being persisted.
            if (settings.autoCommit && !opts.commitMessage?.trim()) {
              console.log(
                chalk.red(
                  "✗ --commit-message is required (auto-commit setting is ON)",
                ),
              );
              console.log(
                chalk.dim(
                  "  Stage your changes first, then provide a one-line commit summary.",
                ),
              );
              console.log(
                chalk.dim(
                  `  Example: vibeflow tasks --edit ${taskId} --set-status review --commit-message "fix: add hover effect" --comment "..."`,
                ),
              );
              process.exitCode = ExitCode.USAGE;
              return;
            }

            // Enforce --branch when createBranch is ON.
            if (settings.createBranch && !opts.branch?.trim()) {
              console.log(
                chalk.red(
                  "✗ --branch is required (create-branch setting is ON)",
                ),
              );
              console.log(
                chalk.dim(
                  "  Provide the git branch name created for this task.",
                ),
              );
              console.log(
                chalk.dim(
                  `  Example: vibeflow tasks --edit ${taskId} --set-status review --branch feat/add-hover-effect --comment "..."`,
                ),
              );
              process.exitCode = ExitCode.USAGE;
              return;
            }
          }

          // ── SaaS edit path (online mode) ────────────────────────────────
          if (editMode === "saas") {
            const saasPatch: {
              status?: string;
              title?: string;
              description?: string;
              branchName?: string;
            } = {};
            if (opts.setStatus) saasPatch.status = opts.setStatus;
            if (opts.title) saasPatch.title = opts.title;
            if (opts.description) saasPatch.description = opts.description;
            if (opts.branch) saasPatch.branchName = opts.branch;

            // Conflict detection: warn when attempting in-progress on an already in-progress task
            if (opts.setStatus === "in-progress") {
              const current = await fetchSaasTask(taskId);
              if (current && toCliStatus(current.status) === "in-progress") {
                const assignee = current.author ?? "another user";
                console.log(
                  chalk.yellow(
                    `⚠  Task is already in-progress (last updated by: ${assignee})`,
                  ),
                );
                console.log(
                  chalk.yellow(
                    "   Another agent or user may be working on this task.",
                  ),
                );
                console.log(
                  chalk.yellow(
                    "   Proceeding — but verify the task is not being worked on elsewhere.",
                  ),
                );
                console.log();
              }
            }

            const saasResult = await updateSaasTask(taskId, saasPatch);
            if (!saasResult) {
              console.log(chalk.red(`✗ Failed to update task: ${taskId}`));
              console.log(
                chalk.yellow(
                  "  Ensure you are connected and the task ID exists in the online board.",
                ),
              );
              process.exitCode = ExitCode.GENERAL;
              return;
            }

            if (saasResult.warning) {
              console.log(
                chalk.yellow(`⚠  Server warning: ${saasResult.warning}`),
              );
            }

            if (opts.setStatus === "review" && opts.comment?.trim()) {
              const commented = await addSaasComment(
                taskId,
                opts.comment.trim(),
              );
              if (commented) console.log(chalk.dim("  comment: added"));
            }

            const saasEditNextActions = opts.setStatus
              ? getNextActions(
                  opts.setStatus === "review"
                    ? "set-status:review"
                    : "set-status:in-progress",
                  taskId,
                )
              : [];
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    success: true,
                    task: saasResult.task,
                    next_actions: saasEditNextActions,
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(
                chalk.green(`✓ Task updated: ${saasResult.task.title}`),
              );
              console.log(
                chalk.dim(
                  `  id: ${saasResult.task.id} | status: ${toCliStatus(saasResult.task.status)}`,
                ),
              );
              if (saasEditNextActions.length > 0)
                printNextHint(saasEditNextActions);
            }
            return;
          }

          // ── Local edit path ──────────────────────────────────────────────
          // Resolve partial ID prefixes to the full task ID so `--edit` behaves like
          // `--get` and `--commit` (both already accept a unique prefix). The resolved
          // ID is used for the write so a partial prefix never hits an exact-match miss.
          const localProjectDir = resolve(dir);
          const resolvedTaskId =
            listTasks(localProjectDir).find(
              (t) => t.id === taskId || t.id.startsWith(taskId),
            )?.id ?? taskId;

          // Enforce verify before review when requireVerifyBeforeReview is ON.
          // Only blocks when actually setting status to review, not other edits.
          // Skip automatically for tasks without URL/selector (non-UI tasks).
          if (
            opts.setStatus === "review" &&
            settings.requireVerifyBeforeReview &&
            !opts.skipVerify
          ) {
            const taskFilePath = findTaskFilePath(
              localProjectDir,
              resolvedTaskId,
            );
            const task = taskFilePath ? readTaskFile(taskFilePath) : null;
            if (task) {
              const hasSelector =
                task.cssSelector || (task.selector && task.selector !== "/");
              const hasUrl = !!task.url;
              const isUiTask = Boolean(hasSelector && hasUrl);

              if (isUiTask && !task.verified) {
                console.log(
                  chalk.red(
                    "✗ vibeflow verify is required before setting status to review",
                  ),
                );
                console.log(
                  chalk.dim(`  Run: vibeflow verify ${resolvedTaskId}`),
                );
                console.log(
                  chalk.dim(
                    `  Or skip: vibeflow tasks --edit ${resolvedTaskId} --set-status review --skip-verify`,
                  ),
                );
                process.exitCode = ExitCode.USAGE;
                return;
              }
            }
          }

          if (opts.dryRun) {
            const dryUpdates: Record<string, unknown> = {};
            if (opts.title) dryUpdates.title = opts.title;
            if (opts.setStatus) dryUpdates.status = opts.setStatus;
            if (opts.description) dryUpdates.description = opts.description;
            if (opts.branch) dryUpdates.branchName = opts.branch;
            if (opts.json) {
              console.log(
                JSON.stringify(
                  {
                    dryRun: true,
                    action: "update",
                    taskId: resolvedTaskId,
                    updates: dryUpdates,
                    next_actions: opts.setStatus
                      ? getNextActions(
                          opts.setStatus === "review"
                            ? "set-status:review"
                            : "set-status:in-progress",
                          resolvedTaskId,
                        )
                      : [],
                  },
                  null,
                  2,
                ),
              );
            } else {
              console.log(chalk.yellow("  [dry-run] Would update task:"));
              console.log(chalk.dim(`    id: ${resolvedTaskId}`));
              for (const [k, v] of Object.entries(dryUpdates)) {
                console.log(chalk.dim(`    ${k}: ${v}`));
              }
              if (opts.setStatus)
                printNextHint(
                  getNextActions(
                    opts.setStatus === "review"
                      ? "set-status:review"
                      : "set-status:in-progress",
                    resolvedTaskId,
                  ),
                );
            }
            return;
          }

          const updates: Partial<
            Pick<
              Task,
              "status" | "title" | "description" | "branchName" | "verified"
            >
          > = {};
          if (opts.title) updates.title = opts.title;
          if (opts.setStatus) updates.status = opts.setStatus as TaskStatus;
          if (opts.description) updates.description = opts.description;
          if (opts.branch) updates.branchName = opts.branch;

          // Warn when setting a Research task to in-progress — should not implement.
          // Also detect in-progress conflicts (task already claimed by another agent/user).
          if (opts.setStatus === "in-progress") {
            const projectDir = resolve(dir);
            const tasks = listTasks(projectDir);
            const editedTask = tasks.find(
              (t) => t.id === taskId || t.id.startsWith(taskId),
            );
            if (editedTask) {
              if ((editedTask.type ?? "").toLowerCase() === "research") {
                console.log(
                  chalk.yellow(
                    "⚠  WARNING: This is a Research task. Policy: do NOT implement code.",
                  ),
                );
                console.log(
                  chalk.yellow(
                    "   Research only — attach a .md report file, leave a summary comment, mark as review.",
                  ),
                );
                console.log();
              }
              if (editedTask.status === "in-progress") {
                const lastUpdated = editedTask.updated
                  ? new Date(editedTask.updated).toLocaleString()
                  : "unknown";
                const assignee = editedTask.author ?? "another user";
                console.log(
                  chalk.yellow(
                    `⚠  Task is already in-progress (author: ${assignee}, last updated: ${lastUpdated})`,
                  ),
                );
                console.log(
                  chalk.yellow(
                    "   Another agent or user may be working on this task.",
                  ),
                );
                console.log(
                  chalk.yellow(
                    "   Proceeding — but verify the task is not being worked on elsewhere.",
                  ),
                );
                console.log();
              }
            }
          }

          // Enforce Research type rules before marking as review.
          if (opts.setStatus === "review") {
            const projectDir = resolve(dir);
            const tasks = listTasks(projectDir);
            const editedTask = tasks.find(
              (t) => t.id === taskId || t.id.startsWith(taskId),
            );
            if (
              editedTask &&
              (editedTask.type ?? "").toLowerCase() === "research"
            ) {
              // Check if a --report-file was provided to upload now
              if (opts.reportFile) {
                const reportPath = resolve(opts.reportFile);
                if (!existsSync(reportPath)) {
                  console.log(
                    chalk.red(`✗ Report file not found: ${reportPath}`),
                  );
                  process.exitCode = ExitCode.NOT_FOUND;
                  return;
                }
                if (!/\.md$/i.test(reportPath)) {
                  console.log(
                    chalk.red("✗ Report file must be a Markdown (.md) file"),
                  );
                  process.exitCode = ExitCode.USAGE;
                  return;
                }
                const content = readFileSync(reportPath);
                const { saveFile: saveTaskFile } = await import(
                  "./core/files.js"
                );
                saveTaskFile(
                  projectDir,
                  editedTask.id,
                  basename(reportPath),
                  content,
                );
                unlinkSync(reportPath);
                console.log(
                  chalk.green(
                    `✓ Report uploaded: ${basename(reportPath)} (local file removed)`,
                  ),
                );
              } else {
                // No --report-file: check if at least one .md file is already attached
                const attachedFiles = listFiles(projectDir, editedTask.id);
                const hasMdFile = attachedFiles.some((f) =>
                  /\.md$/i.test(f.name),
                );
                if (!hasMdFile) {
                  console.log(
                    chalk.red(
                      "✗ Cannot mark Research task as review: no .md report file attached.",
                    ),
                  );
                  console.log(chalk.dim("  Provide a research report:"));
                  console.log(
                    chalk.dim(
                      `    vibeflow tasks --edit ${taskId} --set-status review --report-file ./my-research.md --comment "..."`,
                    ),
                  );
                  process.exitCode = ExitCode.USAGE;
                  return;
                }
              }
            }
          }

          // Reset verified flag when claiming a task for new work
          if (opts.setStatus === "in-progress") {
            updates.verified = false;
          }

          const updated = updateTask(dir, resolvedTaskId, updates);
          if (!updated) {
            console.log(chalk.red(`✗ Task not found: ${taskId}`));
            console.log(
              chalk.yellow(`  Run 'vibeflow tasks' to see available task IDs.`),
            );
            process.exitCode = ExitCode.NOT_FOUND;
            return;
          }

          // Add comment BEFORE the git commit attempt. This guarantees the comment is
          // always persisted even if auto-commit fails (e.g., nothing staged, git error).
          if (opts.setStatus === "review" && opts.comment?.trim()) {
            addComment(
              resolve(dir),
              resolvedTaskId,
              "agent",
              opts.comment.trim(),
            );
            console.log(chalk.dim(`  comment: added`));
          }

          const localEditNextActions = opts.setStatus
            ? getNextActions(
                opts.setStatus === "review"
                  ? "set-status:review"
                  : "set-status:in-progress",
                resolvedTaskId,
              )
            : [];
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  success: true,
                  task: updated,
                  next_actions: localEditNextActions,
                },
                null,
                2,
              ),
            );
          } else {
            console.log(chalk.green(`✓ Task updated: ${updated.title}`));
            console.log(
              chalk.dim(`  id: ${updated.id} | status: ${updated.status}`),
            );
            if (localEditNextActions.length > 0)
              printNextHint(localEditNextActions);
          }

          // ── Auto-commit (runs after task status + comment are already saved) ──────
          // Keeping this after updateTask/addComment ensures comment is preserved even
          // when git commit fails. Failure sets exitCode=1 but does NOT undo the task.
          if (opts.setStatus === "review") {
            const autoDir = resolve(dir);
            const autoSettings = loadSettings(autoDir);
            if (autoSettings.autoCommit && opts.commitMessage?.trim()) {
              const allAutoTasks = listTasks(autoDir);
              const taskForCommit = allAutoTasks.find(
                (t) => t.id === taskId || t.id.startsWith(taskId),
              );
              if (taskForCommit) {
                const commitMsg = `${opts.commitMessage.trim()} [proto:${taskForCommit.id}]`;
                try {
                  execFileSync("git", ["commit", "-m", commitMsg], {
                    cwd: autoDir,
                    stdio: "inherit",
                  });
                  const sha = execSync("git rev-parse HEAD", { cwd: autoDir })
                    .toString()
                    .trim();
                  const commitRecord = {
                    sha,
                    message: opts.commitMessage.trim(),
                    timestamp: new Date().toISOString(),
                  };
                  const existingCommits = taskForCommit.commits ?? [];
                  updateTask(autoDir, taskForCommit.id, {
                    commits: [...existingCommits, commitRecord],
                  });
                  console.log(chalk.green(`✓ Committed: ${commitMsg}`));
                  console.log(chalk.dim(`  sha: ${sha}`));

                  if (autoSettings.autoPush) {
                    console.log(chalk.dim("  pushing..."));
                    const pushed = tryAutoPush(autoDir);
                    if (pushed.ok) {
                      console.log(chalk.green("✓ Pushed"));
                    } else {
                      console.log(
                        chalk.yellow("⚠ Push failed. Run 'git push' manually."),
                      );
                      if (pushed.error)
                        console.log(chalk.dim(`  reason: ${pushed.error}`));
                    }
                  }
                } catch {
                  // Task status and comment are already saved — only the commit failed.
                  console.log(
                    chalk.red(
                      "✗ git commit failed — ensure changes are staged with 'git add'",
                    ),
                  );
                  process.exitCode = ExitCode.GENERAL;
                }
              }
            }
          }

          return;
        }

        // ── List mode ──────────────────────────────────────────────────────
        if (
          opts.status &&
          !VALID_STATUSES.includes(
            opts.status as (typeof VALID_STATUSES)[number],
          )
        ) {
          console.log(chalk.red(`✗ Invalid status filter: "${opts.status}"`));
          console.log(
            chalk.yellow(`  Valid statuses: ${VALID_STATUSES.join(" | ")}`),
          );
          console.log(chalk.dim(`  Example: vibeflow tasks --status todo`));
          process.exitCode = ExitCode.USAGE;
          return;
        }
        if (opts.type && !validateTypeFilter(opts.type)) return;

        const parsedFields = opts.fields
          ? opts.fields
              .split(",")
              .map((f: string) => f.trim())
              .filter(Boolean)
          : [];

        // ── SaaS online mode: fetch from backend ───────────────────────────
        const mode = await getMode();
        if (mode === "saas") {
          const workspace = await readWorkspace();
          const saasData = await fetchSaasTasks(workspace?.id);
          if (!saasData) {
            console.log(chalk.red("✗ Unable to reach the online backend."));
            console.log(
              chalk.yellow(
                "  Check your connection or run 'vibeflow login' if your session expired.",
              ),
            );
            process.exitCode = ExitCode.GENERAL;
            return;
          }

          let saasTasks = saasData.tasks.map((t) => ({
            ...t,
            status: toCliStatus(t.status),
          }));
          if (opts.status)
            saasTasks = saasTasks.filter((t) => t.status === opts.status);
          if (opts.type)
            saasTasks = saasTasks.filter(
              (t) =>
                (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase(),
            );
          if (opts.user && !validateUserFilter(opts.user, saasTasks)) return;
          if (opts.user)
            saasTasks = saasTasks.filter((t) =>
              matchesUserFilter(t.author, opts.user!),
            );
          if (opts.tag && opts.tag.length > 0)
            saasTasks = saasTasks.filter((t) =>
              opts.tag!.every((tag) =>
                ((t as { tags?: string[] }).tags ?? []).includes(tag),
              ),
            );

          const saasLimit =
            opts.limit === undefined ? 5 : parseInt(opts.limit, 10);
          if (!isNaN(saasLimit) && saasLimit > 0)
            saasTasks = saasTasks.slice(0, saasLimit);

          if (opts.json) {
            // SAFETY: SaaS tasks have the same shape as CLI tasks for pickFields purposes
            console.log(
              JSON.stringify(
                saasTasks.map((t) =>
                  pickFields(
                    t as unknown as Record<string, unknown>,
                    parsedFields,
                  ),
                ),
                null,
                2,
              ),
            );
            return;
          }

          const hasResearchTasks = saasTasks.some(
            (t) => (t.type ?? "").toLowerCase() === "research",
          );
          const hasBugTasks = saasTasks.some(
            (t) => (t.type ?? "").toLowerCase() === "bug",
          );

          const saasSettings = loadSettings(resolve(dir));
          printAgentInstructions({
            hasResearchTasks,
            hasBugTasks,
            autoCommit: saasSettings.autoCommit,
            autoPush: saasSettings.autoPush,
            autoComment: saasSettings.autoComment,
            createBranch: saasSettings.createBranch,
            requireVerifyBeforeReview: saasSettings.requireVerifyBeforeReview,
          });

          if (saasTasks.length === 0) {
            console.log(chalk.dim("No tasks found."));
          } else {
            saasTasks = saasTasks.sort((a, b) => {
              const byStatus =
                getStatusRank(a.status) - getStatusRank(b.status);
              if (byStatus !== 0) return byStatus;
              const byPriority =
                getPriorityRank(a.priority ?? undefined) -
                getPriorityRank(b.priority ?? undefined);
              if (byPriority !== 0) return byPriority;
              return (
                new Date(b.updatedAt).getTime() -
                new Date(a.updatedAt).getTime()
              );
            });
            for (const [idx, task] of saasTasks.entries()) {
              const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
              const normalizedType = normalizeTaskType(task.type);
              console.log(
                `  ${chalk.dim(`${idx + 1}.`)} ${colorFn(`[${task.status}]`)} ${task.title}`,
              );
              console.log(chalk.dim(`    id:       ${task.id}`));
              console.log(chalk.dim(`    selector: /`));
              if (normalizedType)
                console.log(chalk.dim(`    type:     ${normalizedType}`));
              if (task.priority)
                console.log(chalk.dim(`    priority: ${task.priority}`));
              console.log(chalk.dim(`    created:  ${task.createdAt}`));
              if (task.description) {
                console.log(chalk.dim(`    description:`));
                for (const line of task.description.split("\n"))
                  console.log(chalk.dim(`      ${line}`));
              }
              if (task.comments && task.comments.length > 0) {
                const sortedComments = [...task.comments].sort(sortByCreatedAt);
                console.log(
                  chalk.dim(`    comments (${sortedComments.length}):`),
                );
                for (const c of sortedComments) {
                  // SaasComment has authorId (not author) and body (not text).
                  const author = c.authorId
                    ? `user:${c.authorId.slice(0, 8)}`
                    : "agent";
                  console.log(chalk.dim(`      [${author}] ${c.createdAt}`));
                  for (const line of c.body.split("\n"))
                    console.log(chalk.dim(`        ${line}`));
                }
              }
              if (task.files && task.files.length > 0) {
                console.log(
                  chalk.dim(`    linked files (${task.files.length}):`),
                );
                for (const f of task.files) {
                  const fileUrl =
                    f.url ??
                    `${process.env.VIBEFLOW_API_URL ?? "https://app.vibeflow.tools"}/api/tasks/${task.id}/files/${encodeURIComponent(f.name)}`;
                  console.log(chalk.dim(`      - ${f.name}  ${fileUrl}`));
                  // Use inlined content from the API response (no extra HTTP request needed).
                  if (f.content) {
                    console.log(chalk.dim(`        ┌── content ──`));
                    for (const line of f.content.split("\n"))
                      console.log(chalk.dim(`        │  ${line}`));
                    console.log(chalk.dim(`        └─────────────`));
                  }
                }
              }
              console.log();
            }

            const allForCount = saasData.tasks.map((t) => ({
              ...t,
              status: toCliStatus(t.status),
            }));
            console.log(chalk.dim(formatStatusSummary(allForCount)));
          }
          return;
        }

        const all = listTasksWithPaths(dir);
        if (opts.user && !validateUserFilter(opts.user, all)) return;
        let filtered = opts.status
          ? all.filter((t) => t.status === opts.status)
          : all;
        if (opts.type)
          filtered = filtered.filter(
            (t) =>
              (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase(),
          );
        if (opts.user)
          filtered = filtered.filter((t) =>
            matchesUserFilter(t.author, opts.user!),
          );
        if (opts.tag && opts.tag.length > 0)
          filtered = filtered.filter((t) =>
            opts.tag!.every((tag) => (t.tags ?? []).includes(tag)),
          );

        const taskLimit =
          opts.limit === undefined ? 5 : parseInt(opts.limit, 10);

        if (opts.json) {
          // SAFETY: Task objects are plain JSON-serializable; Record<string, unknown> is the superset for field picking.
          console.log(
            JSON.stringify(
              filtered.map((t) =>
                pickFields(
                  t as unknown as Record<string, unknown>,
                  parsedFields,
                ),
              ),
              null,
              2,
            ),
          );
          return;
        }

        filtered = filtered.sort((a, b) => {
          const byStatus = getStatusRank(a.status) - getStatusRank(b.status);
          if (byStatus !== 0) return byStatus;
          const byPriority =
            getPriorityRank(a.priority) - getPriorityRank(b.priority);
          if (byPriority !== 0) return byPriority;

          const aDate = new Date(a.updated ?? a.created).getTime();
          const bDate = new Date(b.updated ?? b.created).getTime();
          if (aDate !== bDate) return bDate - aDate;

          return a.id.localeCompare(b.id);
        });

        const totalFiltered = filtered.length;
        if (!isNaN(taskLimit) && taskLimit > 0)
          filtered = filtered.slice(0, taskLimit);

        if (filtered.length === 0) {
          console.log(chalk.dim("No tasks found."));
          return;
        }

        const projectDir = resolve(dir);

        const hasResearchTasks = filtered.some(
          (t) => (t.type ?? "").toLowerCase() === "research",
        );
        const hasBugTasks = filtered.some(
          (t) => (t.type ?? "").toLowerCase() === "bug",
        );

        const settings = loadSettings(projectDir);
        printAgentInstructions({
          hasResearchTasks,
          hasBugTasks,
          autoCommit: settings.autoCommit,
          autoPush: settings.autoPush,
          autoComment: settings.autoComment,
          createBranch: settings.createBranch,
          requireVerifyBeforeReview: settings.requireVerifyBeforeReview,
        });

        const config = readConfig(projectDir);
        for (const [idx, task] of filtered.entries()) {
          const structuredComments = listComments(projectDir, task.id).sort(
            sortByCreatedAt,
          );
          const linkedFiles = listFiles(projectDir, task.id).map((f) => ({
            ...f,
            url: `http://localhost:${config.port}${f.url}`,
          }));
          const agent = formatTaskForAgent(
            task,
            structuredComments,
            linkedFiles,
          );
          printTaskDetails(task, agent, idx, config.port, projectDir);
        }

        const limitSuffix =
          !isNaN(taskLimit) && taskLimit > 0 && totalFiltered > taskLimit
            ? chalk.yellow(
                ` (showing ${taskLimit} of ${totalFiltered} matching — use --limit 0 for all)`,
              )
            : "";
        console.log(chalk.dim(formatStatusSummary(all)) + limitSuffix);
      }
      async function runTasksAndFlush() {
        try {
          await runTasks();
        } finally {
          await flushTelemetry();
        }
      }
      void runTasksAndFlush();
    },
  );

// ── Auth commands (SaaS mode) ──────────────────────────────────────
program
  .command("login", { hidden: true })
  .description(
    "Authenticate CLI against the Vibeflow SaaS backend (device flow)",
  )
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
      console.log(
        chalk.yellow("●  Not logged in") + chalk.dim("  (local mode)"),
      );
      console.log(
        chalk.dim("  Run ") +
          chalk.cyan("vibeflow login") +
          chalk.dim(" to connect to the Vibeflow cloud."),
      );
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
      console.log(
        chalk.dim(
          `  Board:   ${workspace.icon ? workspace.icon + " " : ""}${workspace.name}`,
        ),
      );
      if (workspace.email)
        console.log(chalk.dim(`  Email:   ${workspace.email}`));
      console.log(chalk.dim(`  URL:     `) + chalk.cyan(workspace.url));
    }
    console.log();

    const saasData = await fetchSaasTasks(workspace?.id);
    if (!saasData) {
      console.log(
        chalk.yellow(
          "  ⚠  Could not reach SaaS backend. Check your connection.",
        ),
      );
      return;
    }

    const all = saasData.tasks.map((t) => ({
      ...t,
      status: toCliStatus(t.status),
    }));
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
  .description(
    "Push all local tasks to the Vibeflow SaaS app and delete them locally",
  )
  .argument("[dir]", "Project root directory", ".")
  .option(
    "--workspace <id>",
    "Target workspace ID (defaults to your first workspace)",
  )
  .option(
    "--keep-local-files",
    "Keep local task files after pushing (do not delete them)",
  )
  .action(
    async (
      dir: string,
      opts: { workspace?: string; keepLocalFiles?: boolean },
    ) => {
      capture("command_run", { command: "push" });
      await push(dir, opts);
      await flushTelemetry();
    },
  );

program
  .command("watch")
  .description(
    "Watch the task store and print ticket details for important updates (new tasks, tasks moved to todo)",
  )
  .argument("[dir]", "Project root directory", ".")
  .action(async (dir: string) => {
    capture("command_run", { command: "watch" });
    await flushTelemetry();
    watch(dir);
  });

program
  .command("telemetry")
  .description("Manage CLI usage telemetry (opt-out at any time)")
  .option("--enable", "Enable usage telemetry (default)")
  .option("--disable", "Disable usage telemetry")
  .option("--status", "Show current telemetry status")
  .action(
    async (opts: { enable?: boolean; disable?: boolean; status?: boolean }) => {
      if (opts.disable) {
        setTelemetryEnabled(false);
        console.log(
          chalk.yellow("Telemetry disabled. No usage data will be collected."),
        );
        console.log(
          chalk.dim(
            "Run `vibeflow telemetry --enable` to re-enable at any time.",
          ),
        );
        return;
      }
      if (opts.enable) {
        setTelemetryEnabled(true);
        console.log(
          chalk.green(
            "Telemetry enabled. Thank you for helping improve Vibeflow!",
          ),
        );
        return;
      }
      // Default: show status
      const { enabled, anonymousId } = getTelemetryStatus();
      const envOverride = process.env.VIBEFLOW_TELEMETRY === "0";
      console.log(chalk.bold("Telemetry status:"));
      console.log(
        `  Enabled: ${enabled ? chalk.green("yes") : chalk.yellow("no")}`,
      );
      if (envOverride) {
        console.log(
          chalk.dim(
            "  (disabled via VIBEFLOW_TELEMETRY=0 environment variable)",
          ),
        );
      }
      if (anonymousId) {
        console.log(chalk.dim(`  Anonymous ID: ${anonymousId}`));
      }
      console.log();
      console.log(
        chalk.dim("  vibeflow telemetry --disable   Opt out of usage tracking"),
      );
      console.log(chalk.dim("  vibeflow telemetry --enable    Opt back in"));
      console.log(
        chalk.dim("  No PII is ever collected. User identity is hashed."),
      );
    },
  );

program
  .command("auth")
  .description(
    "Manage stored auth state (encrypted cookies for Playwright verification)",
  )
  .option("--clear", "Delete all per-task encrypted auth state files")
  .option("--list", "List stored auth state files and their age")
  .action(async (opts: { clear?: boolean; list?: boolean }) => {
    capture("command_run", { command: "auth" });
    await flushTelemetry();

    const projectDir = resolve(".");

    if (opts.clear) {
      const deleted = clearAuthState(projectDir);
      if (deleted === 0) {
        console.log(
          chalk.dim("  No auth state files found. Nothing to clear."),
        );
      } else {
        console.log(chalk.green(`  ✓ Cleared ${deleted} auth state file(s)`));
      }
      return;
    }

    if (opts.list) {
      const files = listAuthStateFiles(projectDir);
      if (files.length === 0) {
        console.log(chalk.dim("  No auth state files found."));
        return;
      }
      console.log(chalk.bold(`  Auth state files (${files.length}):`));
      for (const f of files) {
        console.log(
          chalk.dim(`    ${f.taskId}  age: ${f.age}  path: ${f.path}`),
        );
      }
      return;
    }

    // Default: show help
    console.log(chalk.bold("Auth management:"));
    console.log(
      chalk.dim(
        "  vibeflow auth --clear    Delete all per-task encrypted auth state files",
      ),
    );
    console.log(
      chalk.dim(
        "  vibeflow auth --list     List stored auth state files and their age",
      ),
    );
  });

program
  .command("verify")
  .description(
    "Verify a task against its baseline snapshot, or explore captured evidence",
  )
  .argument(
    "[args...]",
    "task-id, or a tool: style_query | style_diff | element_info | html_diff",
  )
  .option("--json", "Output machine-readable JSON")
  .option("--url <url>", "Override target URL (same-origin port changes only)")
  .option(
    "--filter <pattern>",
    "Filter style properties by substring (style_diff only)",
  )
  .action(
    async (
      args: string[],
      opts: { json?: boolean; url?: string; filter?: string },
    ) => {
      capture("command_run", { command: "verify" });
      const [head, ...rest] = args;
      if (head && VERIFY_TOOLS.has(head)) {
        await runVerifyTool(".", head, rest, opts);
        await flushTelemetry();
        return;
      }
      if (!head) {
        process.stderr.write(chalk.red("✗ Task ID required.\n"));
        process.stderr.write(chalk.dim("  Usage: vibeflow verify <task-id>\n"));
        process.stderr.write(
          chalk.dim("  Tools: vibeflow verify <tool> <task-id> [...]\n"),
        );
        process.exitCode = 1;
        return;
      }
      await runVerify(".", head, opts);
      await flushTelemetry();
    },
  );

program
  .command("changelog")
  .description("Show the changelog — latest version by default")
  .option("--all", "Show the full changelog for every version")
  .action(async (opts: { all?: boolean }) => {
    capture("command_run", { command: "changelog" });
    await flushTelemetry();
    showChangelog({ all: opts.all === true });
  });

program.parse();
