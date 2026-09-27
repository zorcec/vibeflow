import { Command, Option } from "commander";
import { execSync, execFileSync } from "node:child_process";
import { serve } from "./server/server.js";
import {
  createTask,
  listTasks,
  listTasksWithPaths,
  updateTask,
  formatTaskForAgent,
  markTaskOpened,
  getCurrentUserId,
  renderTaskForAgent,
  renderAgentInstructions,
  generateTaskId,
  ensureTaskDirs,
  findTaskFilePath,
  findTaskByIdOrPrefix,
  resolveTaskId,
  claimNextTaskAtomic,
  summariseChildren,
  isChildTask,
  writeSortKeyMinimal,
  isResearchType,
  matchesIdOrPrefix,
} from "./core/tasks.js";
import { listComments, addComment } from "./core/comments.js";
import { listFiles } from "./core/files.js";
import { readConfig, getCurrentBranch } from "./core/config.js";
import {
  resolveProjectRoot,
  formatProjectRootAnnouncement,
  type ProjectRootResult,
} from "./core/project-root.js";
import { loadSettings } from "./core/settings.js";
import type { Task, TaskStatus } from "./core/types.js";
import { TASK_STATUSES, getPriorityRank } from "./core/types.js";
import { PROTO_DIR } from "./core/types.js";
import { computeBackfillPlan } from "@vibeflow-tools/ui/kanban";
import { getMode } from "./auth/mode.js";
import { runStdioMcp } from "./mcp/stdio.js";
import {
  taskRelations,
  formatRelationsSummary,
  buildSetParentLinks,
} from "./core/task-links.js";
import { getGitUser } from "./core/git-user.js";
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
  type SaasTask,
} from "./saas/client.js";
import { saasFailure } from "./saas/failure.js";
import { readWorkspace } from "./auth/workspace.js";
import { readFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, join, basename, relative } from "node:path";
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

// Background: refresh SaaS settings if stale (fire-and-forget, non-blocking).
// Skipped when the module is imported for commander-tree introspection
// (VIBEFLOW_CLI_SKIP_REFRESH=1), so importing never triggers a fetch.
if (process.env.VIBEFLOW_CLI_SKIP_REFRESH !== "1") void maybeRefreshSettings();

const STATUS_COLORS: Record<string, (s: string) => string> = {
  backlog: chalk.gray,
  todo: chalk.yellow,
  "in-progress": chalk.blue,
  review: chalk.magenta,
  done: chalk.green,
};

const VALID_TASK_TYPES = new Set(["Task", "Bug", "Research"]);

/** All valid task status values — single source from core/types.ts. */
const VALID_STATUSES = TASK_STATUSES;

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

// getPriorityRank is imported from core/types.ts (single source)

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

/**
 * Pushes, and reports how it went.
 *
 * `captureOutput` is what `--json` passes. Git does not confine its push
 * chatter to stderr — `git push --set-upstream` prints "Branch 'x' set up to
 * track 'origin/x'." on STDOUT — so an INHERITED stdio drops git's own words
 * into the middle of the one JSON document the contract promises on stdout.
 * Human mode keeps inheriting: watching the push is the point of it.
 */
function tryAutoPush(
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
        `commit with vibeflow tasks --commit --task ${taskId} --message "..." -- <paths...>`,
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

/**
 * Splits the `-- <paths...>` pathspec off the raw argv for
 * `vibeflow tasks --commit`.
 *
 * Commander binds the first free operand to the command's optional `[dir]`
 * argument, so `tasks --commit ... -- a.txt b.txt` would set dir="a.txt" and
 * lose the first path. Everything after the `--` separator is removed from the
 * argv handed to commander and returned as the pathspec instead. Only the
 * `tasks --commit` form accepts a pathspec; every other `--` use is untouched.
 */
function splitCommitPathspec(argv: string[]): {
  argv: string[];
  paths: string[];
} {
  const sep = argv.indexOf("--");
  // argv[0..1] are node + script; argv[2] is the sub-command.
  if (sep === -1 || argv[2] !== "tasks") return { argv, paths: [] };
  const before = argv.slice(0, sep);
  if (!before.includes("--commit")) return { argv, paths: [] };
  return { argv: before, paths: argv.slice(sep + 1) };
}

const { argv: programArgv, paths: commitPathspec } = splitCommitPathspec(
  process.argv,
);

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
 * Structured output — the single writer for the `--json` envelope in both
 * directions, so consumers see exactly one convention:
 *   success → `{ok:true, …named payload}` on **stdout**;
 *   failure → `{ok:false, error:{code,message,retryable,suggestion}}` on
 *             **stderr** (stdout stays clean for piping); the caller sets the
 *             non-zero exit code.
 * Human mode: success is a no-op (callers print their own human text);
 * failure writes the chalk message + suggestion to stderr.
 */
function outputEnvelope(
  opts:
    | { ok: true; payload: Record<string, unknown>; json?: boolean }
    | {
        ok: false;
        code: string;
        message: string;
        retryable?: boolean;
        suggestion?: string;
        json?: boolean;
      },
): void {
  if (opts.ok) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, ...opts.payload }, null, 2) + "\n",
      );
    }
    return;
  }
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

/**
 * A note about work that DID land, attached to an `ok:true` payload.
 *
 * A refusal is for "nothing happened" (`ok:false`, non-zero exit); a notice is
 * for "the task data was saved but a follow-on step did not complete" — the
 * exit code stays 0 so a consumer does not retry an edit that already applied.
 */
interface PartialSuccessNotice {
  code: string;
  message: string;
}

/**
 * Partial-success notes for a success payload, always as the `notices` ARRAY;
 * a clean run carries no key at all, so a consumer that only knows `ok` and
 * the named payload keeps working.
 *
 * The name is deliberately NOT `warning`. `warning` is the online board's own
 * passthrough field — a bare STRING chosen by the server — and one key must
 * never mean both an object and a string. `notices` is the local, structured,
 * always-an-array field this CLI owns.
 */
function noticeFields(
  notices: PartialSuccessNotice[],
): Record<string, unknown> {
  return notices.length === 0 ? {} : { notices };
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
function validateTypeFilter(typeFilter: string, json = false): boolean {
  if (
    VALID_FILTER_TYPES.map((t) => t.toLowerCase()).includes(
      typeFilter.toLowerCase(),
    )
  )
    return true;
  if (json) {
    outputEnvelope({
      ok: false,
      code: "E_USAGE",
      message: `Invalid type filter: "${typeFilter}"`,
      suggestion: `Available types: ${VALID_FILTER_TYPES.join(" | ")} — Type filter is exact (example: --type Bug)`,
      json,
    });
  } else {
    console.log(chalk.red(`✗ Invalid type filter: "${typeFilter}"`));
    console.log(
      chalk.yellow(`  Available types: ${VALID_FILTER_TYPES.join(" | ")}`),
    );
    console.log(chalk.dim("  Type filter is exact (example: --type Bug)"));
  }
  process.exitCode = ExitCode.USAGE;
  return false;
}

/** Validates --user filter value; logs error and sets exitCode if invalid. Returns true if valid. */
function validateUserFilter<T extends { author?: string | null }>(
  userFilter: string,
  tasks: T[],
  json = false,
): boolean {
  const availableUsers = collectAvailableUsers(tasks);
  if (availableUsers.length === 0) {
    if (json) {
      outputEnvelope({
        ok: false,
        code: "E_USAGE",
        message:
          "Cannot filter by user: no task authors are available on this board.",
        json,
      });
    } else {
      console.log(
        chalk.red(
          `✗ Cannot filter by user: no task authors are available on this board.`,
        ),
      );
    }
    process.exitCode = ExitCode.USAGE;
    return false;
  }
  if (availableUsers.some((author) => matchesUserFilter(author, userFilter)))
    return true;
  if (json) {
    outputEnvelope({
      ok: false,
      code: "E_USAGE",
      message: `User not found: "${userFilter}"`,
      suggestion: `Available users: ${availableUsers.join(" | ")} — User filter is exact email match (case-insensitive).`,
      json,
    });
  } else {
    console.log(chalk.red(`✗ User not found: "${userFilter}"`));
    console.log(
      chalk.yellow(`  Available users: ${availableUsers.join(" | ")}`),
    );
    console.log(
      chalk.dim("  User filter is exact email match (case-insensitive)."),
    );
  }
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
  allTasks: Task[] = [],
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
  // Derived relations (parent / children / other links)
  if (allTasks.length > 0) {
    const view = taskRelations(allTasks, task.id);
    const relLines = formatRelationsSummary(view);
    for (const line of relLines) console.log(chalk.dim(`    ${line}`));
  }
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

export function createProgram(): Command {
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

/**
 * Reports a CLI-boundary project-root refusal (W1): the message on stderr and
 * `ExitCode.USAGE`, before anything is created. Every refusal names `--project`.
 */
function reportProjectRootFailure(
  failure: Extract<ProjectRootResult, { ok: false }>,
): void {
  console.error(chalk.red(`✗ ${failure.message}`));
  console.error(chalk.yellow(`  ${failure.suggestion}`));
  process.exitCode = ExitCode.USAGE;
}

/** Announces the resolved absolute root on stdout before anything is written. */
function announceProjectRoot(root: Extract<ProjectRootResult, { ok: true }>): void {
  console.log(chalk.green(formatProjectRootAnnouncement(root)));
}

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
  .option(
    "--project <dir>",
    "Project root for the task store and MCP server (ignored when an HTML target is given)",
  )
  .action(
    async (
      target: string | undefined,
      opts: { port: string; open: boolean; host?: string; project?: string },
    ) => {
      capture("command_run", { command: "serve" });
      await flushTelemetry();
      // API-only mode (MCP root): resolve + validate at the CLI boundary and
      // announce the absolute root before serve() creates anything.
      let projectDir: string | undefined;
      if (target === undefined) {
        const root = resolveProjectRoot(opts.project, { mode: "http" });
        if (!root.ok) {
          reportProjectRootFailure(root);
          return;
        }
        announceProjectRoot(root);
        projectDir = root.projectDir;
      }
      await serve(target, {
        port: parseInt(opts.port, 10),
        host: opts.host,
        open: opts.open,
        projectDir,
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
  .option(
    "--project <dir>",
    "Project root directory (overrides the [dir] positional argument)",
  )
  .action(
    async (
      dir: string,
      opts: {
        port: string;
        host?: string;
        open: boolean;
        changelog: boolean;
        project?: string;
      },
    ) => {
      capture("command_run", { command: "kanban" });
      await flushTelemetry();
      const root = resolveProjectRoot(opts.project ?? dir, { mode: "http" });
      if (!root.ok) {
        reportProjectRootFailure(root);
        return;
      }
      announceProjectRoot(root);
      const port = parseInt(opts.port, 10);
      const instance = await serve(undefined, {
        port,
        host: opts.host,
        open: false,
        projectDir: root.projectDir,
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

// W4 — stdio transport. An MCP client spawns this per project, and stdout is
// the JSON-RPC channel: the announcement goes to stderr (announceProjectRoot
// writes to stdout and must not be used here), and neither the update notice,
// capture(), nor flushTelemetry() may run — they are stdout-side effects of
// the human-facing commands.
program
  .command("mcp")
  .description("Run the MCP server over stdio (spawned by an MCP client)")
  .option("--project <dir>", "Project root directory (required)")
  .action(async (opts: { project?: string }) => {
    const root = resolveProjectRoot(opts.project, { mode: "stdio" });
    if (!root.ok) {
      reportProjectRootFailure(root);
      return;
    }
    process.stderr.write(
      `${chalk.green(formatProjectRootAnnouncement(root))}\n`,
    );
    const mode = await getMode();
    await runStdioMcp(root.projectDir, mode === "saas" ? "saas" : "local");
  });

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
  .option(
    "--parent <task-id>",
    "Create the new task as a child of this parent (use with --add; full ID or prefix)",
  )
  .option(
    "--set-parent <task-id>",
    "Set/replace the parent task link (use with --edit; empty string clears)",
  )
  .option("--no-parent", "Remove the parent task link (use with --edit)")
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
    "Report comment — written with any status; required when setting status to review",
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
    "Pick the next available ROOT task in todo, move it to in-progress, and output it ready to work on (never returns a child; the root's children are reported alongside it)",
  )
  .option(
    "--children",
    "Include child tasks in the listing. By default only ROOT tasks are listed — a child belongs to its parent, matching the board. Has no effect with --next, which never returns a child.",
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
  .addOption(
    new Option(
      "--set-verify <verdict>",
      "Agent verification verdict: pass (task IS implemented correctly — green badge), fail (task is NOT correct — amber badge, blocks review), cannot (unverifiable here — requires --verify-reason; records no badge)",
    ).choices(["pass", "fail", "cannot"]),
  )
  .option(
    "--verify-reason <reason>",
    "Why the task cannot be verified — REQUIRED when --set-verify cannot; recorded in the task's activity",
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
    "--reindex-sort-keys",
    "One-time maintenance: re-key keyless and same-column duplicate tasks so the rendered order survives (idempotent; honors --dry-run/--json)",
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
        setParent?: string;
        parent?: string | boolean;
        json?: boolean;
        commit?: boolean;
        get?: string;
        next?: boolean;
        children?: boolean;
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
        setVerify?: "pass" | "fail" | "cannot";
        verifyReason?: string;
        priority?: string;
        reindexSortKeys?: boolean;
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
                : opts.reindexSortKeys
                  ? "reindex"
                  : "list";
        capture("command_run", {
          command: "tasks",
          subcommand: taskSubcommand,
        });

        // ── --parent is --add-only ──────────────────────────────────────
        // (--edit uses --set-parent / --no-parent; --no-parent arrives as
        // the boolean `false`, never a string, so it is unaffected here.)
        if (typeof opts.parent === "string" && !opts.add) {
          outputEnvelope({ ok: false,
            code: "E_USAGE",
            message: "--parent is only valid with --add",
            suggestion:
              'Example: vibeflow tasks --add --title "Fix CTA spacing" --parent 358fcff6',
            json: opts.json,
          });
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // ── --comment requires --edit ────────────────────────────────────
        // --comment is read only inside the --edit block (the bare form used
        // to fall through to list mode and silently write nothing). Fail
        // loudly instead of pretending the comment landed.
        if (opts.comment?.trim() && opts.edit === undefined) {
          outputEnvelope({ ok: false,
            code: "E_USAGE",
            message: "--comment requires --edit <task-id>",
            suggestion:
              'vibeflow tasks --edit <id> --comment "what changed and why"',
            json: opts.json,
          });
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // ── Reindex sort keys (one-time maintenance) ────────────────────────
        // Re-key the tasks the comparator cannot order (keyless / 'n' / same-
        // column duplicates) without touching the well-formed, column-unique
        // keys around them. Only `sortKey` is written via updateTask, so links
        // are untouched; updateTask bumps `updated`, which is harmless once
        // keys decide order but does show on "last modified" surfaces.
        if (opts.reindexSortKeys) {
          if (
            opts.add ||
            opts.edit !== undefined ||
            opts.get ||
            opts.next ||
            opts.commit
          ) {
            outputEnvelope({ ok: false,
              code: "E_USAGE",
              message:
                "--reindex-sort-keys cannot be combined with --add/--edit/--get/--next/--commit",
              json: opts.json,
            });
            process.exitCode = ExitCode.USAGE;
            return;
          }
          const projectDir = resolve(dir);
          const allTasks = listTasks(projectDir);
          // Reproduce exactly what the board renders: the server maps
          // `created` -> `createdAt` and leaves `updatedAt` unset on initial
          // load, so this is the order compareTaskOrder sees at render time.
          const view = allTasks.map((t) => ({
            id: t.id,
            status: t.status,
            sortKey: t.sortKey,
            createdAt: t.created,
          }));
          const patches = computeBackfillPlan(view);
          const titles = new Map(allTasks.map((t) => [t.id, t.title]));
          const oldKeys = new Map(allTasks.map((t) => [t.id, t.sortKey]));
          const manifest = patches.map((p) => ({
            id: p.id,
            oldKey: oldKeys.get(p.id) ?? null,
            newKey: p.sortKey,
          }));

          if (opts.dryRun) {
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  dryRun: true,
                  count: manifest.length,
                  anchorRule:
                    "whole-store unique keys (a key duplicated anywhere is re-keyed)",
                  patches: manifest,
                },
              });
            } else {
              console.log(
                chalk.yellow(
                  `  [dry-run] Would reindex ${manifest.length} task sortKey(s):`,
                ),
              );
              // Deviation from the plan, recorded so the next reader sees it:
              // the plan specified per-column anchors, but a same-column
              // duplicate sitting between two equal cross-column anchors cannot
              // be order-preserved. Whole-store uniqueness can. +9 tasks vs
              // per-column. See docs/plans/sortkey-fix.md §7, correction 8.
              console.log(
                chalk.dim(
                  "  Anchor rule: whole-store unique keys — a key duplicated anywhere is re-keyed, so mixed-status sibling groups keep their order.",
                ),
              );
              for (const m of manifest) {
                console.log(
                  chalk.dim(`    ${m.id}  ${titles.get(m.id) ?? ""}`),
                );
                console.log(
                  chalk.dim(`      ${m.oldKey ?? "(none)"} → ${m.newKey}`),
                );
              }
            }
            return;
          }

          let written = 0;
          const unwritten: string[] = [];
          for (const p of patches) {
            // Write minimally ON PURPOSE. `updateTask` re-serialises through
            // normalizeTask, which drops legacy fields (the singleton `commit`
            // among them — that once cost 18 commit SHAs), reorders keys and
            // adds defaults. This command must touch only `sortKey`/`updated`.
            // Do NOT refactor it back onto updateTask.
            if (writeSortKeyMinimal(projectDir, p.id, p.sortKey)) written++;
            else unwritten.push(p.id);
          }

          // Two outcomes, not one. `writeSortKeyMinimal` can compute a patch
          // and then decline to write it (a task file with neither a
          // `sortKey` nor an `updated` field has nothing to edit in place), so
          // a run that PLANNED writes and wrote NONE never touched the store.
          // Reporting that as `ok:true` would tell a consumer the re-keying
          // landed when nothing did — the one lie this contract must not make.
          // Nothing landed, so it is a refusal with a non-zero exit. Refuse
          // BEFORE the manifest, which records an apply that did not happen.
          if (patches.length > 0 && written === 0) {
            const message = `Reindex wrote 0 of ${patches.length} planned sortKey patch(es) — no task file was changed.`;
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "REINDEX_WRITE_FAILED",
                message,
                suggestion: `Each write needs a readable task file carrying a "sortKey" or "updated" field to edit in place; unwritable: ${unwritten.join(", ")}`,
                json: opts.json,
              });
            } else {
              console.log(chalk.red(`✗ ${message}`));
              console.log(
                chalk.dim(
                  `  Each write needs a readable task file carrying a "sortKey" or "updated" field to edit in place; unwritable: ${unwritten.join(", ")}`,
                ),
              );
            }
            process.exitCode = ExitCode.GENERAL;
            return;
          }

          // Machine-readable manifest (outside tasks/, so it never enters the
          // store listing). No git operations are performed anywhere here.
          // Only written when the run actually changed something: a re-run is
          // idempotent (zero patches) and must not clobber the record of the
          // apply that did the work.
          const manifestPath = join(
            projectDir,
            PROTO_DIR,
            "reindex-sort-keys-manifest.json",
          );
          if (manifest.length > 0) {
            writeFileSync(
              manifestPath,
              JSON.stringify(
                { generatedAt: new Date().toISOString(), patches: manifest },
                null,
                2,
              ),
              "utf-8",
            );
          }

          // In-command post-assert: no keyless tasks, no same-column dup groups.
          const after = listTasks(projectDir);
          const keyless = after.filter((t) => !t.sortKey);
          const openKeyless = keyless.filter((t) => t.status !== "done");
          const byStatus = new Map<string, Map<string, number>>();
          for (const t of after) {
            if (!t.sortKey) continue;
            const counts = byStatus.get(t.status) ?? new Map<string, number>();
            counts.set(t.sortKey, (counts.get(t.sortKey) ?? 0) + 1);
            byStatus.set(t.status, counts);
          }
          const dupOffenders: string[] = [];
          for (const [status, counts] of byStatus) {
            for (const [key, n] of counts) {
              if (n > 1) dupOffenders.push(`${status}: ${key} ×${n}`);
            }
          }
          const reindexVerified =
            openKeyless.length === 0 &&
            keyless.length === 0 &&
            dupOffenders.length === 0;

          // Past the refusal above, `written > 0`: the re-keying itself landed,
          // so only the post-assert can fail. That is a NOTICE on a successful
          // run, not a refusal — the exit code stays 0 and `reindexVerified:
          // false` says so.
          const reindexNotices: PartialSuccessNotice[] = reindexVerified
            ? []
            : [
                {
                  code: "REINDEX_INCOMPLETE",
                  message: `Reindex incomplete: ${keyless.length} keyless (${openKeyless.length} open), ${dupOffenders.length} same-column duplicate group(s).`,
                },
              ];

          if (opts.json) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                reindexVerified,
                written,
                manifestPath,
                remainingKeyless: keyless.length,
                sameColumnDuplicateGroups: dupOffenders.length,
                patches: manifest,
                ...noticeFields(reindexNotices),
              },
            });
          } else if (reindexVerified) {
            console.log(
              chalk.green(
                `✓ Reindexed ${written} task sortKey(s); 0 keyless, 0 same-column duplicate groups.`,
              ),
            );
            console.log(
              chalk.dim(
                "  Anchor rule: whole-store unique keys — a key duplicated anywhere is re-keyed, so mixed-status sibling groups keep their order. See docs/plans/sortkey-fix.md §7.",
              ),
            );
            console.log(chalk.dim(`  manifest: ${manifestPath}`));
            console.log(
              chalk.dim(
                "  note: only sortKey changed; updateTask also bumped each task's `updated` timestamp.",
              ),
            );
          } else {
            // No longer a failure (the keys were written and the exit code
            // stays 0), so the marker changes with the semantics; the sentence
            // is the one `--json` carries as the warning message.
            console.log(
              chalk.yellow(
                `⚠ Reindex incomplete: ${keyless.length} keyless (${openKeyless.length} open), ${dupOffenders.length} same-column duplicate group(s).`,
              ),
            );
            for (const o of dupOffenders) console.log(chalk.dim(`    ${o}`));
          }
          return;
        }

        // ── Get single task mode ───────────────────────────────────────
        if (opts.get) {
          const getTaskMode = await getMode();
          if (getTaskMode === "saas") {
            const workspace = await readWorkspace();
            const saasData = await fetchSaasTasks(workspace?.id);
            if (!saasData.ok) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  ...saasFailure(saasData.error),
                  message: "Unable to reach the online backend.",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red("✗ Unable to reach the online backend."),
                );
              }
              process.exitCode = ExitCode.GENERAL;
              return;
            }
            const saasTask = saasData.data.tasks.find((t) =>
              matchesIdOrPrefix(t, opts.get!),
            );
            if (!saasTask) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "TASK_NOT_FOUND",
                  message: `Task not found: ${opts.get}`,
                  suggestion:
                    "Run 'vibeflow tasks' to see available task IDs.",
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ Task not found: ${opts.get}`));
              }
              process.exitCode = ExitCode.NOT_FOUND;
              return;
            }
            const cliStatus = toCliStatus(saasTask.status);
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: { task: { ...saasTask, status: cliStatus } },
              });
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
          const task = allWithPaths.find((t) =>
            matchesIdOrPrefix(t, opts.get!),
          );
          if (!task) {
            outputEnvelope({ ok: false,
              code: "TASK_NOT_FOUND",
              message: `Task not found: ${opts.get}`,
              suggestion: "Run 'vibeflow tasks' to see available task IDs.",
              json: opts.json,
            });
            process.exitCode = ExitCode.NOT_FOUND;
            return;
          }
          // Mark task as opened by current user
          const currentUser = getCurrentUserId();
          markTaskOpened(projectDir, task.id, currentUser);

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
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                task: pickFields(
                  {
                    ...task,
                    comments: structuredComments,
                    files: linkedFiles,
                  } as unknown as Record<string, unknown>,
                  getFields,
                ),
              },
            });
            return;
          }
          const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
          const allTasks = allWithPaths.map(
            (t) => ({ ...t, id: t.id }) as import("./core/types").Task,
          );
          const agentMessage = renderTaskForAgent(
            task,
            task.filePath,
            structuredComments,
            linkedFiles,
            projectDir,
            allTasks,
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
            if (!saasData.ok) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  ...saasFailure(saasData.error),
                  message: "Unable to reach the online backend.",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red("✗ Unable to reach the online backend."),
                );
              }
              process.exitCode = ExitCode.GENERAL;
              return;
            }
            if (opts.type && !validateTypeFilter(opts.type, opts.json)) return;
            let todoTasks = saasData.data.tasks
              .map((t: SaasTask) => ({ ...t, status: toCliStatus(t.status) }))
              .filter((t: { status: string }) => t.status === "todo");
            if (opts.type)
              todoTasks = todoTasks.filter(
                (t) =>
                  (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase(),
              );
            if (
              opts.user &&
              !validateUserFilter(opts.user, todoTasks, opts.json)
            )
              return;
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
              // Defensive: updateSaasTask resolves a SaasResult, never a
              // falsy value, so this only fires if that contract changes.
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "E_BACKEND_UNAVAILABLE",
                  retryable: true,
                  message: `Failed to move task to in-progress: ${nextTask.id}`,
                  suggestion:
                    "Check your connection or run 'vibeflow login', then retry.",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red(
                    `✗ Failed to move task to in-progress: ${nextTask.id}`,
                  ),
                );
              }
              process.exitCode = ExitCode.GENERAL;
              return;
            }

            const nextSaasNextActions = getNextActions(
              "set-status:in-progress",
              nextTask.id,
            );
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  task: { ...nextTask, status: "in-progress" },
                  next_actions: nextSaasNextActions,
                },
              });
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
          if (opts.type && !validateTypeFilter(opts.type, opts.json)) return;
          if (opts.user && !validateUserFilter(opts.user, [], opts.json)) return;

          const nextUpdated = claimNextTaskAtomic(nextProjectDir, {
            type: opts.type,
            user: opts.user,
            tag: opts.tag,
            author: getGitUser(nextProjectDir).name,
            // OWNER DECISION: --next never returns a child. The root is the unit
            // of work; its children come back alongside it.
            rootsOnly: true,
          });

          if (!nextUpdated) {
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

          const nextLocalNextActions = getNextActions(
            "set-status:in-progress",
            nextUpdated.id,
          );
          // The root is the unit of work: report its children and their
          // statuses alongside it, so the agent can see what remains without a
          // second call. Empty for a childless root.
          const nextLocalChildren = summariseChildren(
            listTasks(nextProjectDir),
            nextUpdated.id,
          );
          if (opts.json) {
            const nextLocalPayload: Record<string, unknown> = {
              task: nextUpdated,
              next_actions: nextLocalNextActions,
            };
            if (nextLocalChildren.length > 0) {
              nextLocalPayload.children = nextLocalChildren;
            }
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: nextLocalPayload,
            });
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
          const nextLocalFilePath =
            findTaskFilePath(nextProjectDir, nextUpdated.id) ?? "";
          const allTasks = listTasks(nextProjectDir);
          const agentMessage = renderTaskForAgent(
            nextUpdated,
            nextLocalFilePath,
            structuredComments,
            linkedFiles,
            nextProjectDir,
            allTasks,
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
          // The root is the unit of work — surface its children and their statuses
          // so the agent sees what remains without a second call.
          if (nextLocalChildren.length > 0) {
            const doneCount = nextLocalChildren.filter(
              (c) => c.status === "done",
            ).length;
            console.log(
              chalk.bold(
                `  ↓ ${nextLocalChildren.length} child task${nextLocalChildren.length === 1 ? "" : "s"} (${doneCount} done)`,
              ),
            );
            for (const child of nextLocalChildren) {
              const statusColour =
                child.status === "done"
                  ? chalk.green
                  : child.status === "in-progress"
                    ? chalk.blue
                    : chalk.dim;
              console.log(
                `    ${statusColour(`[${child.status}]`)} ${chalk.dim(child.id)} ${child.title}`,
              );
            }
            console.log();
          }
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
            outputEnvelope({ ok: false,
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
            if (typeof opts.parent === "string") {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "E_USAGE",
                  message: "--parent is only supported for local tasks",
                  suggestion:
                    "Parent links are not supported by the online backend yet.",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red("✗ --parent is only supported for local tasks"),
                );
                console.log(
                  chalk.dim(
                    "  Parent links are not supported by the online backend yet.",
                  ),
                );
              }
              process.exitCode = ExitCode.USAGE;
              return;
            }
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
                outputEnvelope({
                  ok: true,
                  json: opts.json,
                  payload: {
                    dryRun: true,
                    action: "create",
                    task: dryTask,
                    next_actions: getNextActions("add", newId),
                  },
                });
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
            if (!saasCreated.ok) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  ...saasFailure(saasCreated.error),
                  message: "Failed to create task in online board.",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red("✗ Failed to create task in online board."),
                );
                console.log(
                  chalk.yellow(
                    "  Check your connection or run 'vibeflow login'.",
                  ),
                );
              }
              process.exitCode = ExitCode.GENERAL;
              return;
            }
            const saasCreatedTask = saasCreated.data;
            const addNextActions = getNextActions("add", saasCreatedTask.id);
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  task: saasCreatedTask,
                  next_actions: addNextActions,
                },
              });
            } else {
              console.log(
                chalk.green(`✓ Task created: ${saasCreatedTask.title}`),
              );
              console.log(
                chalk.dim(
                  `  id: ${saasCreatedTask.id} | status: ${toCliStatus(saasCreatedTask.status)}`,
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

          // ── Parent link (--parent) ─────────────────────────────────────
          // Resolve a full ID or prefix the same way --get/--set-parent do,
          // then reject a dangling target with the wording the --set-parent
          // path emits. A brand-new task has no id yet, so self-link,
          // duplicate and cycle are structurally impossible (see report).
          let parentId: string | undefined;
          if (typeof opts.parent === "string") {
            const rawParent = opts.parent;
            const parentTasks = listTasks(projectDir);
            parentId = resolveTaskId(projectDir, rawParent);
            if (!parentTasks.some((t) => t.id === parentId)) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "TASK_NOT_FOUND",
                  message: `Parent task not found: ${parentId}`,
                  suggestion: "Run 'vibeflow tasks' to see available task IDs.",
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ Parent task not found: ${parentId}`));
                console.log(
                  chalk.dim("  Run 'vibeflow tasks' to see available task IDs."),
                );
              }
              process.exitCode = ExitCode.NOT_FOUND;
              return;
            }
          }

          if (opts.dryRun) {
            const dryId = generateTaskId();
            const dryTask = {
              id: dryId,
              title: opts.title.trim(),
              description: opts.description?.trim() ?? "",
              status,
              selector: "/",
              ...(parentId
                ? { links: [{ taskId: parentId, type: "parent" as const }] }
                : {}),
            };
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  dryRun: true,
                  action: "create",
                  task: dryTask,
                  next_actions: getNextActions("add", dryId),
                },
              });
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
            // Attribute the task to the task-store repo's git identity so an
            // agent-created task matches a human-created one.
            author: getGitUser(projectDir).name,
            ...(opts.type ? { type: opts.type } : {}),
            ...(opts.priority ? { priority: opts.priority } : {}),
            ...(opts.tag?.length ? { tags: opts.tag } : {}),
            // Link shape matches the --edit --set-parent path exactly.
            ...(parentId
              ? { links: [{ taskId: parentId, type: "parent" as const }] }
              : {}),
          });

          const localAddNextActions = getNextActions("add", created.id);
          if (opts.json) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                task: created,
                next_actions: localAddNextActions,
              },
            });
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
            outputEnvelope({ ok: false,
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
          const task = findTaskByIdOrPrefix(projectDir, opts.task!);
          if (!task) {
            outputEnvelope({ ok: false,
              code: "TASK_NOT_FOUND",
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
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  dryRun: true,
                  action: "commit",
                  message: commitMsg,
                  taskId: task.id,
                  next_actions: getNextActions("commit", task.id),
                },
              });
            } else {
              console.log(chalk.yellow("  [dry-run] Would commit:"));
              console.log(chalk.dim(`    message: ${commitMsg}`));
              console.log(chalk.dim(`    task:    ${task.id}`));
              printNextHint(getNextActions("commit", task.id));
            }
            return;
          }
          // Warn when committing for a Research task — code changes should not be made.
          // (Under --json stdout carries only the envelope — this warning is
          // human-mode only.)
          if (!opts.json && (task.type ?? "").toLowerCase() === "research") {
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
          try {
            const { commitTaskPaths } = await import("./core/git.js");
            const result = commitTaskPaths(
              projectDir,
              task.id,
              baseMsg,
              commitPathspec,
            );
            if (!result.ok) {
              // Nothing was written on this path, so this is a refusal, not a
              // partial success: the task record is untouched. Same code as
              // the throw below and as the post-review auto-commit notice —
              // "git could not commit" is one meaning, and it is not
              // `E_USAGE` (that is reserved for a bad flag value).
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "GIT_COMMIT_FAILED",
                  message: result.error,
                  suggestion:
                    "Stage the task's paths with 'git add' and retry the commit.",
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ ${result.error}`));
              }
              process.exitCode = ExitCode.GENERAL;
              return;
            }

            // Visibility: with no pathspec the scope is the task's own record.
            // Name any other staged paths so the caller knows they were left in
            // the index on purpose rather than silently dropped.
            if (commitPathspec.length === 0 && result.foreign.length > 0 && !opts.json) {
              // Human mode only — under --json the same paths are reported as
              // `leftStaged` inside the envelope, and stdout carries only that.
              console.log(
                chalk.yellow(
                  "⚠  Staged changes that do NOT belong to this task were left in the index (not committed):",
                ),
              );
              for (const p of result.foreign) {
                console.log(chalk.dim(`     ${p}`));
              }
              console.log(
                chalk.dim(
                  '   Commit explicit paths with: tasks --commit --task <id> --message "<msg>" -- <paths...>',
                ),
              );
              console.log();
            }

            // Auto-push is a best-effort VCS side-effect — the commit above
            // already landed, and `vibeflow push` remains the documented retry.
            // It still RUNS under `--json`: what `--json` suppresses is the
            // human progress lines below, not the push itself (the sibling
            // `--edit` auto-commit path works exactly this way). So the attempt
            // happens HERE, before the envelope: a failure has to ride the
            // payload, because printing it would be trailing garbage behind the
            // one document the contract promises on stdout.
            // A linked HEAD created no new commit, so there is nothing to push.
            const commitSettings = loadSettings(projectDir);
            const autoPush =
              commitSettings.autoPush && !result.linkedExisting
                ? {
                    attempted: true,
                    ...tryAutoPush(projectDir, { captureOutput: opts.json }),
                  }
                : { attempted: false, ok: true };

            const commitNextActions = getNextActions("commit", task.id);
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  commit: result.sha,
                  linkedExisting: result.linkedExisting,
                  committed: result.committed,
                  leftStaged: result.foreign,
                  // The push ran; this says how it went. `attempted: false`
                  // covers a linked existing commit (nothing new to push) and a
                  // store with autoPush off.
                  autoPush,
                  next_actions: commitNextActions,
                },
              });
            } else if (result.linkedExisting) {
              // Nothing to commit is NOT a dead end: the caller's intent is to
              // record that this task's work is in commit X, and when the work
              // is already committed, X is HEAD.
              const reason =
                commitPathspec.length > 0
                  ? `no changes to commit for: ${commitPathspec.join(", ")}`
                  : "the task's own record has no staged changes";
              console.log(chalk.yellow(`ℹ  Nothing to commit — ${reason}.`));
              console.log(
                chalk.green(`✓ Linked existing commit to task: ${task.title}`),
              );
              console.log(chalk.dim(`  commit: ${result.sha} (HEAD)`));
              console.log(chalk.dim(`  proto:  ${task.id}`));
              printNextHint(commitNextActions);
            } else {
              console.log(
                chalk.green(`✓ Committed and linked to task: ${task.title}`),
              );
              console.log(chalk.dim(`  commit: ${result.sha}`));
              console.log(chalk.dim(`  proto:  ${task.id}`));
              printNextHint(commitNextActions);
            }

            // Human-mode only: the push itself already ran above; these lines
            // are the progress report, and under `--json` they would be
            // trailing garbage behind the envelope.
            if (autoPush.attempted && !opts.json) {
              console.log(
                chalk.dim("  auto-push: pushing commit to remote..."),
              );
              if (autoPush.ok) {
                console.log(chalk.green("✓ Auto-push complete"));
              } else {
                console.log(
                  chalk.yellow(
                    "⚠ Auto-push failed. Commit is local; run 'git push' manually.",
                  ),
                );
                if (autoPush.error) {
                  console.log(chalk.dim(`  reason: ${autoPush.error}`));
                }
              }
            }
          } catch (err) {
            // Nothing was written on this path either, so the refusal is
            // truthful: no commit record, no task-file change. The code is the
            // SAME `GIT_COMMIT_FAILED` the notice path uses — here it means
            // "nothing was committed", there "the task was written but the
            // commit did not happen" — so `E_USAGE` keeps its one meaning
            // (a bad flag value or an impossible combination) and the code↔exit
            // -code pairing stays intact.
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "GIT_COMMIT_FAILED",
                message:
                  "git commit failed — ensure changes are staged with 'git add'",
                suggestion:
                  err instanceof Error
                    ? err.message
                    : "Stage the task's paths with 'git add' and retry.",
                json: opts.json,
              });
            } else {
              console.log(
                chalk.red(
                  "✗ git commit failed — ensure changes are staged with 'git add'",
                ),
              );
              if (err instanceof Error) {
                console.log(chalk.dim(`  reason: ${err.message}`));
              }
            }
            process.exitCode = ExitCode.GENERAL;
          }
          return;
        }

        // ── Edit mode ──────────────────────────────────────────────────────
        if (opts.edit !== undefined) {
          const taskId = typeof opts.edit === "string" ? opts.edit : undefined;
          const wantsParentChange =
            opts.setParent !== undefined || opts.parent === false;
          const hasEdits =
            opts.title ||
            opts.setStatus ||
            opts.description ||
            wantsParentChange ||
            opts.reportFile ||
            opts.setVerify ||
            opts.verifyReason?.trim() ||
            opts.comment?.trim();

          if (!taskId || !hasEdits) {
            if (opts.type && !validateTypeFilter(opts.type, opts.json)) return;
            // Under `--json` this block is a refusal, not a help screen: the
            // help is chalk prose, and a machine consumer asked to
            // `JSON.parse(stdout)` cannot read it. It IS an impossible flag
            // combination (no task id and nothing to edit), which is exactly
            // what `E_USAGE` means everywhere else in this command. Human mode
            // keeps the browse/help block verbatim — it is a real affordance
            // for an agent that passed the wrong flags.
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "E_USAGE",
                message: !taskId
                  ? "--edit needs a task id and at least one edit flag, e.g. --edit <id> --set-status review"
                  : "nothing to edit: pass at least one of --title / --set-status / --description / --set-parent / --no-parent / --report-file / --set-verify / --verify-reason / --comment",
                suggestion:
                  "Run 'vibeflow tasks' (without --json) for the usage instructions and the list of editable task ids.",
                json: opts.json,
              });
              process.exitCode = ExitCode.USAGE;
              return;
            }
            let all = listTasks(dir);
            if (opts.status) all = all.filter((t) => t.status === opts.status);
            if (opts.type)
              all = all.filter(
                (t) =>
                  (t.type ?? "Task").toLowerCase() === opts.type!.toLowerCase(),
              );
            if (opts.user && !validateUserFilter(opts.user, all, opts.json)) return;
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
                '  vibeflow tasks [dir] --edit <task-id> [--title "new title"] [--set-status backlog|todo|in-progress|review|done] [--description "new description"] [--set-parent <task-id> | --no-parent]',
              ),
            );
            console.log(
              chalk.cyan(
                "  verification verdict (agent-only): [--set-verify pass|fail|cannot]  (required at review for annotated tasks; pass = correct, fail = NOT correct — blocks review; cannot needs --verify-reason \"<why>\" and records no badge)",
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
            console.log(
              chalk.dim(
                "  vibeflow tasks --edit abc12345 --set-parent parent12345",
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

          // ── --report-file preconditions (validated before any mutation) ──
          // The flag only means something when a Research task moves to review.
          // Fail loudly instead of silently ignoring an impossible upload.
          let reportTaskId: string | undefined;
          if (opts.reportFile) {
            if (opts.setStatus !== "review") {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "E_USAGE",
                  message: "--report-file requires --set-status review",
                  suggestion: `Example: vibeflow tasks --edit ${taskId} --set-status review --report-file report.md`,
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red("✗ --report-file requires --set-status review"),
                );
                console.log(
                  chalk.dim(
                    `  Example: vibeflow tasks --edit ${taskId} --set-status review --report-file report.md`,
                  ),
                );
              }
              process.exitCode = ExitCode.USAGE;
              return;
            }
            const reportTask = findTaskByIdOrPrefix(resolve(dir), taskId);
            if (!reportTask) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "TASK_NOT_FOUND",
                  message: `Task not found: ${taskId}`,
                  suggestion:
                    "Run 'vibeflow tasks' to see available task IDs.",
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ Task not found: ${taskId}`));
                console.log(
                  chalk.dim(
                    "  Run 'vibeflow tasks' to see available task IDs.",
                  ),
                );
              }
              process.exitCode = ExitCode.NOT_FOUND;
              return;
            }
            if ((reportTask.type ?? "").toLowerCase() !== "research") {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "E_USAGE",
                  message: `--report-file is only supported for Research tasks (this task has type: ${reportTask.type || "none"}).`,
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red(
                    `✗ --report-file is only supported for Research tasks (this task has type: ${reportTask.type || "none"}).`,
                  ),
                );
              }
              process.exitCode = ExitCode.USAGE;
              return;
            }
            reportTaskId = reportTask.id;
          }

          // Notes about work that landed but did not finish — the human prose
          // below is prose, and under `--json` stdout must stay parseable, so
          // each note is also collected here and rides the success payload as
          // `notices`. Collected ABOVE both the SaaS and the local edit branch
          // so every payload of this command carries the same field.
          const editNotices: PartialSuccessNotice[] = [];

          if (opts.setStatus === "done") {
            editNotices.push({
              code: "SET_STATUS_DONE",
              message:
                'Agents should NEVER set a task status to "done" — only a human marks a task done after reviewing. Use --set-status review instead.',
            });
            if (!opts.json) {
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
          }

          if (
            opts.setStatus &&
            !VALID_STATUSES.includes(
              opts.setStatus as (typeof VALID_STATUSES)[number],
            )
          ) {
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "E_USAGE",
                message: `Invalid status: "${opts.setStatus}"`,
                suggestion: `Valid statuses: ${VALID_STATUSES.join(" | ")} — Example: vibeflow tasks --edit ${taskId} --set-status in-progress`,
                json: opts.json,
              });
            } else {
              console.log(
                chalk.red(`✗ Invalid status: "${opts.setStatus}"`),
              );
              console.log(
                chalk.yellow(
                  `  Valid statuses: ${VALID_STATUSES.join(" | ")}`,
                ),
              );
              console.log(
                chalk.dim(
                  `  Example: vibeflow tasks --edit ${taskId} --set-status in-progress`,
                ),
              );
            }
            process.exitCode = ExitCode.USAGE;
            return;
          }

          // NOTE: the missing-comment check used to live here as a duplicate
          // early return with a human-only message — it fired BEFORE the
          // unified gate below, so `--json` consumers never saw
          // REVIEW_COMMENT_REQUIRED. The gate is the single source of truth.

          // ── Agent verification verdict ────────────────────────────────────
          // `verified` is written by the AGENT, never by `vibeflow verify`:
          // verify only proves the annotated element resolves and that no NEW
          // console errors appeared, which cannot tell whether the task was
          // accomplished. Resolve the tri-state flag once, before the review
          // gate: pass → true, fail → false, cannot → absent (with a reason).
          const { resolveVerifyAttestation } = await import(
            "./core/verify-attestation.js"
          );
          const attestation = resolveVerifyAttestation({
            setVerify: opts.setVerify,
            verifyReason: opts.verifyReason,
          });
          if (!attestation.ok) {
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: attestation.code,
                message: attestation.message,
                json: opts.json,
              });
            } else {
              console.log(chalk.red(`✗ ${attestation.message}`));
            }
            process.exitCode = ExitCode.USAGE;
            return;
          }

          // ── Research tasks cannot carry a verification verdict ─────────────
          // Standalone --set-verify on a Research task must be rejected the same
          // way the review gate does (RESEARCH_VERIFY_NOT_ALLOWED). This covers
          // both the real write and the --dry-run preview path.
          if (attestation.verdict) {
            const probeTask = findTaskByIdOrPrefix(resolve(dir), taskId);
            if (probeTask && isResearchType(probeTask.type)) {
              // The code mirrors what the review gate returns for the same rule,
              // so --json consumers see one code whichever path refuses first.
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "RESEARCH_VERIFY_NOT_ALLOWED",
                  message:
                    "A Research task cannot carry a verification verdict — it has no annotated UI to verify",
                  suggestion:
                    "Drop --set-verify; submit the Research task with its .md report instead",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red(
                    "\u2717 A Research task cannot carry a verification verdict \u2014 it has no annotated UI to verify",
                  ),
                );
                console.log(
                  chalk.dim(
                    "  Drop --set-verify; submit the Research task with its .md report instead",
                  ),
                );
              }
              process.exitCode = ExitCode.USAGE;
              return;
            }
          }

          // ── Settings-based enforcement on review ─────────────────────────
          const editMode = await getMode();
          const projectDir = resolve(dir);
          const settings = loadSettings(projectDir);
          // ── Research report upload (CLI side-effect — must run before gate)
          // Task existence / type / transition were validated above, so only
          // the report file itself is left to check here.
          if (opts.setStatus === "review" && opts.reportFile) {
            const reportPath = resolve(opts.reportFile);
            if (!existsSync(reportPath)) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "E_NOT_FOUND",
                  message: `Report file not found: ${reportPath}`,
                  suggestion: "Pass an existing .md path to --report-file.",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red(`✗ Report file not found: ${reportPath}`),
                );
              }
              process.exitCode = ExitCode.NOT_FOUND;
              return;
            }
            if (!/\.md$/i.test(reportPath)) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "E_USAGE",
                  message: "Report file must be a Markdown (.md) file",
                  suggestion: "Rename the report to <name>.md and retry.",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red(
                    "✗ Report file must be a Markdown (.md) file",
                  ),
                );
              }
              process.exitCode = ExitCode.USAGE;
              return;
            }
            const content = readFileSync(reportPath);
            const { saveFile: saveTaskFile } = await import("./core/files.js");
            saveTaskFile(
              projectDir,
              reportTaskId!,
              basename(reportPath),
              content,
            );
            unlinkSync(reportPath);
            if (!opts.json) {
              console.log(
                chalk.green(
                  `✓ Report uploaded: ${basename(reportPath)} (local file removed)`,
                ),
              );
            }
          }
          // ── Unified review gate (shared with MCP + PATCH) ──────────────
          if (opts.setStatus === "review") {
            const { checkReviewTransition } = await import(
              "./core/review-gate.js"
            );
            // Resolve a partial ID prefix BEFORE the gate: the gate reads the
            // task file to decide whether it is annotated, so a short prefix
            // (matching how --get/--edit resolve) would otherwise bypass the
            // verdict check entirely.
            const gateTaskId = resolveTaskId(projectDir, taskId);
            const gate = checkReviewTransition(
              projectDir,
              gateTaskId,
              {
                comment: opts.comment,
                commitMessage: opts.commitMessage,
                branch: opts.branch,
                verifyVerdict: attestation.verdict,
                verifyReason: opts.verifyReason,
              },
              { projectDir, settings },
            );
            if (!gate.ok) {
              if (opts.json) {
                // Machine-readable gate refusal: the gate's code (e.g.
                // REVIEW_COMMENT_REQUIRED, COMMIT_MESSAGE_REQUIRED) reaches
                // --json consumers on stderr instead of human prose on stdout.
                outputEnvelope({
                  ok: false,
                  code: gate.code,
                  message: gate.message,
                  suggestion: gate.suggestion,
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ ${gate.message}`));
                if (gate.suggestion)
                  console.log(chalk.dim(`  ${gate.suggestion}`));
              }
              process.exitCode = ExitCode.USAGE;
              return;
            }
          }

          // ── SaaS edit path (online mode) ────────────────────────────────
          if (wantsParentChange && editMode === "saas") {
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "E_USAGE",
                message:
                  "--set-parent / --no-parent is only supported for local tasks",
                suggestion:
                  "Parent links are not supported by the online backend yet.",
                json: opts.json,
              });
            } else {
              console.log(
                chalk.red(
                  "✗ --set-parent / --no-parent is only supported for local tasks",
                ),
              );
              console.log(
                chalk.dim(
                  "  Parent links are not supported by the online backend yet.",
                ),
              );
            }
            process.exitCode = ExitCode.USAGE;
            return;
          }
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
              // Human-mode only: under --json stdout carries only the envelope.
              if (
                !opts.json &&
                current &&
                toCliStatus(current.status) === "in-progress"
              ) {
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
            if (!saasResult.ok) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  ...saasFailure(saasResult.error),
                  message: `Failed to update task: ${taskId}`,
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ Failed to update task: ${taskId}`));
                console.log(
                  chalk.yellow(
                    "  Ensure you are connected and the task ID exists in the online board.",
                  ),
                );
              }
              process.exitCode = ExitCode.GENERAL;
              return;
            }
            const saasResultData = saasResult.data;

            if (saasResultData.warning && !opts.json) {
              console.log(
                chalk.yellow(`⚠  Server warning: ${saasResultData.warning}`),
              );
            }

            let saasCommentError: string | undefined;
            if (opts.comment?.trim()) {
              const commented = await addSaasComment(
                taskId,
                opts.comment.trim(),
              );
              if (commented.ok) {
                if (!opts.json) console.log(chalk.dim("  comment: added"));
              } else {
                saasCommentError = commented.error.message;
                if (!opts.json) {
                  console.log(
                    chalk.red(
                      `✗ Comment was NOT saved: ${commented.error.message}`,
                    ),
                  );
                }
                process.exitCode = ExitCode.GENERAL;
              }
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
              if (saasCommentError) {
                outputEnvelope({
                  ok: false,
                  code: "E_COMMENT_SAVE",
                  message: `Task updated, but the comment was NOT saved: ${saasCommentError}`,
                  suggestion:
                    'Re-add the comment with --edit <task-id> --comment "..."',
                  json: opts.json,
                });
              } else {
                outputEnvelope({
                  ok: true,
                  json: opts.json,
                  payload: {
                    task: saasResultData.task,
                    next_actions: saasEditNextActions,
                    // Two different fields on purpose: `warning` is the
                    // server's own passthrough STRING, `notices` is this CLI's
                    // structured array. A consumer that branches on one cannot
                    // trip over the other's shape.
                    ...(saasResultData.warning
                      ? { warning: saasResultData.warning }
                      : {}),
                    ...noticeFields(editNotices),
                  },
                });
              }
            } else {
              console.log(
                chalk.green(`✓ Task updated: ${saasResultData.task.title}`),
              );
              console.log(
                chalk.dim(
                  `  id: ${saasResultData.task.id} | status: ${toCliStatus(saasResultData.task.status)}`,
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
          const resolvedTaskId = resolveTaskId(localProjectDir, taskId);

          // Verify gate already checked above via checkReviewTransition

          if (opts.dryRun) {
            const dryUpdates: Record<string, unknown> = {};
            if (opts.title) dryUpdates.title = opts.title;
            if (opts.setStatus) dryUpdates.status = opts.setStatus;
            if (opts.description) dryUpdates.description = opts.description;
            if (wantsParentChange)
              dryUpdates.parent =
                opts.parent === false || opts.setParent === ""
                  ? "(cleared)"
                  : (opts.setParent ?? "(cleared)");
            if (opts.branch) dryUpdates.branchName = opts.branch;
            if (attestation.verdict === "cannot") {
              dryUpdates.verified = "(cleared — cannot verify)";
              dryUpdates.verifyReason = attestation.reason;
            } else if (attestation.clear) {
              dryUpdates.verified = "(cleared)";
            } else if (attestation.value !== undefined) {
              dryUpdates.verified = attestation.value;
            }
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
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
              });
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
              | "status"
              | "title"
              | "description"
              | "branchName"
              | "verified"
              | "author"
              | "links"
            >
          > = {};
          if (opts.title) updates.title = opts.title;
          if (opts.setStatus) updates.status = opts.setStatus as TaskStatus;
          if (opts.description) updates.description = opts.description;
          if (opts.branch) updates.branchName = opts.branch;

          // Author attribution on status changes: claiming a task
          // (in-progress) sets the current git identity; any other transition
          // only backfills a missing author so an existing one is never lost.
          if (opts.setStatus) {
            const existingAuthor = listTasks(localProjectDir).find(
              (t) => t.id === resolvedTaskId,
            )?.author;
            if (opts.setStatus === "in-progress" || !existingAuthor) {
              updates.author = getGitUser(localProjectDir).name;
            }
          }

          // ── Parent link change (--set-parent / --no-parent) ────────────
          // Resolve the parent prefix the same way --edit/--get/--commit do,
          // then compute the new links via the pure helper (set/replace/clear
          // with exists/self/cycle validation).
          let parentDisplay: string | undefined;
          if (wantsParentChange) {
            const rawParent =
              opts.parent === false ? "" : (opts.setParent ?? "");
            if (rawParent === "") {
              const cleared = buildSetParentLinks({
                allTasks: listTasks(localProjectDir),
                taskId: resolvedTaskId,
                parentId: null,
              });
              if (!cleared.ok) {
                // The producer knows why it refused — pass its code straight
                // through instead of re-deriving one from the reason string.
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    code: cleared.code,
                    message: cleared.reason,
                    json: opts.json,
                  });
                } else {
                  console.log(chalk.red(`✗ ${cleared.reason}`));
                }
                process.exitCode = ExitCode.NOT_FOUND;
                return;
              }
              updates.links = cleared.links;
              parentDisplay = "(cleared)";
            } else {
              const resolvedParentId = resolveTaskId(
                localProjectDir,
                rawParent,
              );
              const applied = buildSetParentLinks({
                allTasks: listTasks(localProjectDir),
                taskId: resolvedTaskId,
                parentId: resolvedParentId,
              });
              if (!applied.ok) {
                // The producer knows why it refused — pass its code straight
                // through instead of re-deriving one from the reason string.
                const appliedSuggestion =
                  applied.code === "TASK_NOT_FOUND"
                    ? "Run 'vibeflow tasks' to see available task IDs."
                    : undefined;
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    code: applied.code,
                    message: applied.reason,
                    suggestion: appliedSuggestion,
                    json: opts.json,
                  });
                } else {
                  console.log(chalk.red(`✗ ${applied.reason}`));
                  console.log(
                    chalk.dim(
                      `  Run 'vibeflow tasks' to see available task IDs.`,
                    ),
                  );
                }
                process.exitCode =
                  applied.code === "TASK_NOT_FOUND"
                    ? ExitCode.NOT_FOUND
                    : ExitCode.USAGE;
                return;
              }
              updates.links = applied.links;
              parentDisplay = resolvedParentId;
            }
          }

          // Warn when setting a Research task to in-progress — should not implement.
          // Also detect in-progress conflicts (task already claimed by another agent/user).
          if (opts.setStatus === "in-progress") {
            const projectDir = resolve(dir);
            const editedTask = findTaskByIdOrPrefix(projectDir, taskId);
            if (editedTask) {
              if ((editedTask.type ?? "").toLowerCase() === "research") {
                editNotices.push({
                  code: "RESEARCH_NO_IMPLEMENT",
                  message:
                    "This is a Research task. Policy: do NOT implement code — research only, attach a .md report file, leave a summary comment, mark as review.",
                });
                if (!opts.json) {
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
              }
              if (editedTask.status === "in-progress") {
                const lastUpdated = editedTask.updated
                  ? new Date(editedTask.updated).toLocaleString()
                  : "unknown";
                const assignee = editedTask.author ?? "another user";
                editNotices.push({
                  code: "ALREADY_IN_PROGRESS",
                  message: `Task is already in-progress (author: ${assignee}, last updated: ${lastUpdated}) — another agent or user may be working on this task.`,
                });
                if (!opts.json) {
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
          }

          // Research report upload + gate already handled above (before SaaS path)

          // Reset the verify flag when claiming a task for new work. Clear it
          // to `undefined` (omit the key) rather than writing `false`, so the
          // persisted value stays tri-state: `true` = the agent verified the
          // task IS implemented correctly, `false` = the agent verified it is
          // NOT, absence = nothing assessed yet.
          if (opts.setStatus === "in-progress") {
            updates.verified = undefined;
          }

          // Agent verdict, applied after the reset-on-claim above: the reset
          // is the default for a claim that carries no verdict, while a verdict
          // passed deliberately in the same call (e.g. in-progress +
          // --set-verify fail) is what gets recorded. `cannot` clears the key
          // (absent = not assessed — no badge) — distinct from `fail`, which
          // stores false (verified WRONG).
          if (attestation.verdict === "cannot") {
            updates.verified = undefined;
          } else if (attestation.clear) {
            updates.verified = undefined;
          } else if (attestation.value !== undefined) {
            updates.verified = attestation.value;
          }

          const updated = updateTask(dir, resolvedTaskId, updates);
          if (!updated) {
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "TASK_NOT_FOUND",
                message: `Task not found: ${taskId}`,
                suggestion: "Run 'vibeflow tasks' to see available task IDs.",
                json: opts.json,
              });
            } else {
              console.log(chalk.red(`✗ Task not found: ${taskId}`));
              console.log(
                chalk.yellow(
                  `  Run 'vibeflow tasks' to see available task IDs.`,
                ),
              );
            }
            process.exitCode = ExitCode.NOT_FOUND;
            return;
          }

          // A comment is written whenever --comment is supplied, whatever the
          // status. It must be AWAITED before reporting success: addComment is
          // async and takes a task lock, so an un-awaited call is a floating
          // promise that races process exit and silently loses the comment.
          let commentError: string | undefined;
          if (opts.comment?.trim()) {
            try {
              await addComment(
                resolve(dir),
                resolvedTaskId,
                "agent",
                opts.comment.trim(),
              );
            } catch (err) {
              commentError = err instanceof Error ? err.message : String(err);
            }
          }

          // A "cannot" verdict's reason is recorded in the task's activity
          // (system comment) so the detail panel shows why the task carries no
          // verdict. Only reachable when the verdict + reason passed the gate.
          // Losing it is the SAME situation as losing `--comment` — task data
          // the caller explicitly asked for went missing — so it earns the
          // same `E_COMMENT_SAVE` refusal rather than a warning printed to
          // stdout where a `--json` consumer cannot see it.
          let verifyReasonError: string | undefined;
          if (attestation.verdict === "cannot" && attestation.reason) {
            try {
              await addComment(
                resolve(dir),
                resolvedTaskId,
                "agent",
                `**Cannot verify:** ${attestation.reason}`,
                undefined,
                "system",
              );
            } catch (err) {
              verifyReasonError =
                err instanceof Error ? err.message : String(err);
              if (!opts.json) {
                console.log(
                  chalk.yellow(
                    `⚠ Verify reason was NOT recorded: ${verifyReasonError}`,
                  ),
                );
              }
            }
          }

          const localEditNextActions = opts.setStatus
            ? getNextActions(
                opts.setStatus === "review"
                  ? "set-status:review"
                  : "set-status:in-progress",
                resolvedTaskId,
              )
            : [];
          // The success envelope is written AFTER the auto-commit below, so a
          // commit that did not happen rides the same payload as a `notices`
          // entry instead of being a second document — and the exit code stays
          // 0, because the task data is already on disk and retrying the edit
          // would be wrong. The collection itself is declared far above (next
          // to the `--set-status done` note) so every note of this command
          // lands in one array.
          if (!opts.json) {
            console.log(chalk.green(`✓ Task updated: ${updated.title}`));
            console.log(
              chalk.dim(`  id: ${updated.id} | status: ${updated.status}`),
            );
            if (parentDisplay !== undefined)
              console.log(chalk.dim(`  parent: ${parentDisplay}`));
            if (opts.comment?.trim()) {
              if (commentError) {
                console.log(
                  chalk.red(`✗ Comment was NOT saved: ${commentError}`),
                );
              } else {
                console.log(chalk.dim(`  comment: added`));
              }
            }
            if (localEditNextActions.length > 0)
              printNextHint(localEditNextActions);
          }
          // A comment is part of the TASK DATA: losing it leaves the task
          // genuinely incomplete, so this stays a refusal with a non-zero exit.
          // (A commit, by contrast, is a VCS side-effect outside the task data
          // — see the auto-commit block below.) A lost `--verify-reason` is the
          // same loss with the same remedy, so it is the same code: one code,
          // one meaning.
          if (commentError || verifyReasonError) {
            const lost = commentError
              ? {
                  message: `Task updated, but the comment was NOT saved: ${commentError}`,
                  suggestion:
                    'Re-add the comment with --edit <task-id> --comment "..."',
                }
              : {
                  message: `Task updated, but the verify reason was NOT recorded: ${verifyReasonError}`,
                  suggestion:
                    'Re-record it with --edit <task-id> --set-verify cannot --verify-reason "<why>"',
                };
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "E_COMMENT_SAVE",
                message: lost.message,
                suggestion: lost.suggestion,
                json: opts.json,
              });
            }
            process.exitCode = ExitCode.GENERAL;
          }

          // ── Auto-commit (runs after task status + comment are already saved) ──────
          // Keeping this after updateTask/addComment ensures comment is preserved even
          // when git commit fails. Failure sets exitCode=1 but does NOT undo the task.
          if (opts.setStatus === "review" && !commentError && !verifyReasonError) {
            const autoDir = resolve(dir);
            const autoSettings = loadSettings(autoDir);
            if (autoSettings.autoCommit && opts.commitMessage?.trim()) {
              const taskForCommit = findTaskByIdOrPrefix(autoDir, taskId);
              if (taskForCommit) {
                const { commitTaskChanges } = await import("./core/git.js");
                const commitResult = commitTaskChanges(
                  autoDir,
                  taskForCommit.id,
                  opts.commitMessage.trim(),
                );
                if (commitResult.ok) {
                  // Human notices only — under --json stdout already carried
                  // the envelope; progress/failure is signalled by the exit code.
                  if (!opts.json) {
                    console.log(
                      chalk.green(
                        `✓ Committed: ${opts.commitMessage.trim()} [proto:${taskForCommit.id}]`,
                      ),
                    );
                    console.log(chalk.dim(`  sha: ${commitResult.sha}`));
                  }

                  if (autoSettings.autoPush) {
                    if (!opts.json) console.log(chalk.dim("  pushing..."));
                    const pushed = tryAutoPush(autoDir, {
                      captureOutput: opts.json,
                    });
                    if (pushed.ok) {
                      if (!opts.json) console.log(chalk.green("✓ Pushed"));
                    } else if (!opts.json) {
                      console.log(
                        chalk.yellow("⚠ Push failed. Run 'git push' manually."),
                      );
                      if (pushed.error)
                        console.log(chalk.dim(`  reason: ${pushed.error}`));
                    }
                  }
                } else {
                  // Task status and comment are ALREADY saved — only the commit failed.
                  // Say so plainly: the old wording implied nothing was written.
                  // This is a NOTICE, not a refusal (see the note above the
                  // auto-commit block): the task data is on disk, so `ok` stays
                  // true, the exit code stays 0, and the note rides the payload.
                  const taskFilePath = findTaskFilePath(
                    autoDir,
                    taskForCommit.id,
                  );
                  const relTaskPath = taskFilePath
                    ? relative(autoDir, taskFilePath)
                    : `.vibeflow/tasks/<date>/${taskForCommit.id}.json`;
                  const stageHint = `Stage the task's own file, then commit manually: git add ${relTaskPath}`;
                  editNotices.push({
                    code: "GIT_COMMIT_FAILED",
                    message: commitResult.error
                      ? `Task WAS updated (status + comment saved), but the commit did NOT happen: ${commitResult.error}`
                      : "Task WAS updated (status + comment saved), but the commit did NOT happen.",
                  });
                  if (!opts.json) {
                    console.log(
                      chalk.yellow(
                        "⚠ Task WAS updated (status + comment saved), but the commit did NOT happen.",
                      ),
                    );
                    console.log(chalk.dim(`  ${stageHint}`));
                    if (commitResult.error)
                      console.log(chalk.dim(`  reason: ${commitResult.error}`));
                  }
                }
              }
            }
          }

          // The success envelope is written last so `notices` describes the run
          // the consumer actually got — including a commit that did not land.
          if (opts.json && !commentError && !verifyReasonError) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                task: updated,
                next_actions: localEditNextActions,
                ...noticeFields(editNotices),
              },
            });
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
          if (opts.json) {
            outputEnvelope({
              ok: false,
              code: "E_USAGE",
              message: `Invalid status filter: "${opts.status}"`,
              suggestion: `Valid statuses: ${VALID_STATUSES.join(" | ")} — Example: vibeflow tasks --status todo`,
              json: opts.json,
            });
          } else {
            console.log(
              chalk.red(`✗ Invalid status filter: "${opts.status}"`),
            );
            console.log(
              chalk.yellow(`  Valid statuses: ${VALID_STATUSES.join(" | ")}`),
            );
            console.log(chalk.dim(`  Example: vibeflow tasks --status todo`));
          }
          process.exitCode = ExitCode.USAGE;
          return;
        }
        if (opts.type && !validateTypeFilter(opts.type, opts.json)) return;

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
          if (!saasData.ok) {
            if (opts.json) {
              outputEnvelope({
                ok: false,
                ...saasFailure(saasData.error),
                message: "Unable to reach the online backend.",
                json: opts.json,
              });
            } else {
              console.log(
                chalk.red("✗ Unable to reach the online backend."),
              );
              console.log(
                chalk.yellow(
                  "  Check your connection or run 'vibeflow login' if your session expired.",
                ),
              );
            }
            process.exitCode = ExitCode.GENERAL;
            return;
          }

          let saasTasks = saasData.data.tasks.map((t: SaasTask) => ({
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
          if (
            opts.user &&
            !validateUserFilter(opts.user, saasTasks, opts.json)
          )
            return;
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
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                tasks: saasTasks.map((t) =>
                  pickFields(
                    t as unknown as Record<string, unknown>,
                    parsedFields,
                  ),
                ),
                // The online backend has no parent links, so nothing is hidden.
                hiddenChildren: 0,
              },
            });
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

            const allForCount = saasData.data.tasks.map((t: SaasTask) => ({
              ...t,
              status: toCliStatus(t.status),
            }));
            console.log(chalk.dim(formatStatusSummary(allForCount)));
          }
          return;
        }

        const all = listTasksWithPaths(dir);
        if (opts.user && !validateUserFilter(opts.user, all, opts.json)) return;
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

        // OWNER DECISION: list ROOT tasks only by default. A child belongs to its
        // parent and is rendered inside its card on the board, so listing it as a
        // peer here would contradict the board. `--children` includes them.
        // Counted AFTER the other filters so the footer describes this query.
        const matchingChildren = filtered.filter(isChildTask);
        const hiddenChildCount = opts.children ? 0 : matchingChildren.length;
        if (!opts.children) {
          filtered = filtered.filter((t) => !isChildTask(t));
        }

        const taskLimit =
          opts.limit === undefined ? 5 : parseInt(opts.limit, 10);

        if (opts.json) {
          // SAFETY: Task objects are plain JSON-serializable; Record<string, unknown> is the superset for field picking.
          // `hiddenChildren` reports how many matching child tasks were omitted
          // from `tasks` (root-only listing is the default; pass --children).
          outputEnvelope({
            ok: true,
            json: opts.json,
            payload: {
              tasks: filtered.map((t) =>
                pickFields(
                  t as unknown as Record<string, unknown>,
                  parsedFields,
                ),
              ),
              hiddenChildren: hiddenChildCount,
            },
          });
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
          printTaskDetails(task, agent, idx, config.port, projectDir, all);
        }

        const limitSuffix =
          !isNaN(taskLimit) && taskLimit > 0 && totalFiltered > taskLimit
            ? chalk.yellow(
                ` (showing ${taskLimit} of ${totalFiltered} matching — use --limit 0 for all)`,
              )
            : "";
        // Never hide existence silently: name the flag that reveals the children.
        const childSuffix =
          hiddenChildCount > 0
            ? chalk.dim(
                ` · ${hiddenChildCount} child task${hiddenChildCount === 1 ? "" : "s"} hidden (use --children)`,
              )
            : "";
        console.log(
          chalk.dim(formatStatusSummary(all)) + limitSuffix + childSuffix,
        );
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
      // Additive: show the root and branch get_project reports over MCP, so
      // the mapped CLI surface actually displays what the tool returns
      // instead of only resolving a root it never prints.
      console.log(chalk.dim(`  Project:  ${projectDir}`));
      console.log(
        chalk.dim(`  Branch:   ${getCurrentBranch(projectDir) ?? "none"}`),
      );
      console.log();
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
          `  Board:   ${workspace.icon ? `${workspace.icon} ` : ""}${workspace.name}`,
        ),
      );
      if (workspace.email)
        console.log(chalk.dim(`  Email:   ${workspace.email}`));
      console.log(chalk.dim(`  URL:     `) + chalk.cyan(workspace.url));
    }
    console.log();

    const saasData = await fetchSaasTasks(workspace?.id);
    if (!saasData.ok) {
      console.log(
        chalk.yellow(
          "  ⚠  Could not reach SaaS backend. Check your connection.",
        ),
      );
      return;
    }

    const all = saasData.data.tasks.map((t: SaasTask) => ({
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
  .option(
    "--dry-run",
    "Preview what would be pushed without making any changes",
  )
  .action(
    async (
      dir: string,
      opts: { workspace?: string; keepLocalFiles?: boolean; dryRun?: boolean },
    ) => {
      capture("command_run", { command: "push" });
      await push(dir, opts);
      await flushTelemetry();
    },
  );

program
  .command("watch")
  .description(
    "Watch the task store for task updates (new, moved-to-todo, status, comments, files, priority, description).\n" +
      "  Daemon mode (default): watch continuously and print ticket details.\n" +
      "  --once mode: one-shot poll, emit events, exit.\n" +
      "  --json: emit JSONL to stdout.\n" +
      "  --output <file>: append JSONL to file.\n" +
      "  --webhook <url>: POST each event to URL.\n" +
      "  State: .vibeflow/watch-state.json (append-only journal, per-consumer cursors).\n" +
      "  Gap rule: events older than 1 min that were not delivered trigger a gap event.",
  )
  .argument("[dir]", "Project root directory", ".")
  .option("--json", "Emit events as JSONL lines to stdout")
  .option("--output <file>", "Append JSONL events to a file")
  .option("--webhook <url>", "POST each event as JSON to a webhook URL")
  .option("--once", "One-shot poll: diff against state, emit events, exit")
  .action(
    async (
      dir: string,
      opts: {
        json?: boolean;
        output?: string;
        webhook?: string;
        once?: boolean;
      },
    ) => {
      capture("command_run", { command: "watch" });
      await flushTelemetry();
      watch(dir, opts);
    },
  );

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
        if (opts.json) {
          outputEnvelope({
            ok: false,
            code: "E_USAGE",
            message: "Task ID required.",
            suggestion:
              "Usage: vibeflow verify <task-id> — Tools: vibeflow verify <tool> <task-id> [...]",
            json: opts.json,
          });
        } else {
          process.stderr.write(chalk.red("✗ Task ID required.\n"));
          process.stderr.write(
            chalk.dim("  Usage: vibeflow verify <task-id>\n"),
          );
          process.stderr.write(
            chalk.dim("  Tools: vibeflow verify <tool> <task-id> [...]\n"),
          );
        }
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

  return program;
}

// `programArgv` is process.argv with the `tasks --commit` pathspec removed (see
// splitCommitPathspec): commander cannot receive it, so it arrives via the
// module-level `commitPathspec` instead.
//
// Entry guard: importing this module for introspection must not execute the
// CLI. Tests set VIBEFLOW_CLI_SKIP_PARSE=1 / VIBEFLOW_CLI_SKIP_REFRESH=1, then
// dynamically import, to obtain the commander tree without running a command
// or touching the network.
if (process.env.VIBEFLOW_CLI_SKIP_PARSE !== "1") {
  createProgram().parse(programArgv);
}
