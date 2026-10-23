import { Command, Option } from "commander";
import { serve } from "./server/server.js";
import {
  buildIntegrationGuide,
  buildKanbanReadyLines,
  printGuideLines,
} from "./server/startup-guide.js";
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
  summariseChildren,
  getParentId,
  isResearchType,
} from "./core/tasks.js";
import { addComment } from "./core/comments.js";
import { resolveListLimit } from "./core/task-listing.js";
import { DEFAULT_LIST_LIMIT } from "@vibeflow-tools/api-core";
import { readConfig, getCurrentBranch } from "./core/config.js";
import {
  resolveProjectRoot,
  formatProjectRootAnnouncement,
  type ProjectRootResult,
} from "./core/project-root.js";
import { loadSettings } from "./core/settings.js";
import type { Task, TaskStatus } from "./core/types.js";
import { TASK_STATUSES, TASK_TYPE_VALUES } from "./core/types.js";
import { getMode } from "./auth/mode.js";
import {
  resolveReadBackend,
  resolveReadPorts,
} from "./core/operation-context.js";
import * as operations from "./core/operations.js";
import type { OperationContext } from "./core/operations.js";
import type {
  ClaimNextTaskInputType,
  ListTasksInputType,
} from "@vibeflow-tools/api-core";
import {
  collectBlockedCandidates,
  collectStrandedCandidates,
} from "./core/claim-eligibility.js";
import {
  localListJsonPayload,
  remoteListJsonPayload,
  localGetJsonPayload,
  operationRefusalEnvelope,
  refusalExitCode,
} from "./cli/renderers/task-reads.js";
import { runStdioMcp } from "./mcp/stdio.js";
import {
  taskRelations,
  formatRelationsSummary,
  formatSaasDetailRelations,
  hasSaasDetailRelations,
  buildSetParentLinks,
  buildAddLinks,
  buildRemoveLinks,
} from "./core/task-links.js";
import { getGitUser } from "./core/git-user.js";
import { formatCommitTag } from "./core/commit-tag.js";
import { login, maybeRefreshSettings } from "./auth/login.js";
import { getApiUrl, surfacePath } from "./core/api-url.js";
import { logout } from "./auth/logout.js";
import { push } from "./commands/push.js";
import { pull } from "./commands/pull.js";
import { showChangelog } from "./commands/changelog.js";
import { changelogText, readChangelogContent } from "./core/changelog.js";
import { clearAuthState, listAuthStateFiles } from "./commands/auth.js";
import { printOpenApi } from "./commands/openapi.js";
import { runVerify } from "./commands/verify.js";
import { runVerifyTool, VERIFY_TOOLS } from "./commands/verify-tools.js";
import {
  fetchSaasTasks,
  fetchSaasTask,
  fetchSaasTaskDetail,
  updateSaasTask,
  addSaasComment,
  createSaasTask,
  resolveSaasTaskId,
  toCliStatus,
  type SaasTask,
} from "./saas/client.js";
import { saasFailure, saasReadErrorMessage } from "./saas/failure.js";
import { writeOnlineClone } from "./saas/clone.js";
import { readWorkspace } from "./auth/workspace.js";
import { readFileSync, existsSync, statSync, unlinkSync } from "node:fs";
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

// Display vocabulary for task types: the documented store values (see
// TASK_TYPE_VALUES in core/types.ts). The store keeps ANY non-empty label
// (a user-written `Chore` round-trips through push/pull byte-identical);
// display still shows only the documented values and omits the rest — a
// display choice, never a record rewrite.
const VALID_TASK_TYPES = new Set<string>(TASK_TYPE_VALUES);

/** All valid task status values — single source from core/types.ts. */
const VALID_STATUSES = TASK_STATUSES;

/**
 * Coarse status-transition properties for the `command_run` event emitted by
 * `tasks --edit`. `from_status` is the target task's status before the edit;
 * `to_status` the status it is being moved to (the current status when the
 * edit passes no valid `--set-status`, so a content-only edit shows as a
 * self-pair). Both values are enum-bounded — `from_status` because listTasks
 * normalizes status to TASK_STATUSES, `to_status` by the VALID_STATUSES check
 * — and carry no task id, title, or path: the analytics payload stays tiny
 * and PII-free.
 *
 * Omitted entirely when the target task cannot be resolved locally (unknown
 * id, or an online-mode task with no local file), so a failed edit never
 * fabricates a transition.
 */
function editStatusTelemetryProps(
  projectDir: string,
  edit: string | boolean | undefined,
  setStatus: string | undefined,
): Record<string, string> {
  if (typeof edit !== "string") return {};
  // ONE id rule: exact id wins, else a UNIQUE prefix — an ambiguous or
  // unknown value resolves to nothing and the event is omitted, exactly
  // like the --edit write path refuses it (never a silent first-match).
  const allTasks = listTasks(projectDir);
  const resolved = resolveSaasTaskId(
    allTasks.map((t) => ({ id: t.id, title: t.title })),
    edit,
  );
  if (!resolved.ok) return {};
  const task = allTasks.find((t) => t.id === resolved.id);
  if (!task) return {};
  const toStatus =
    setStatus !== undefined &&
    VALID_STATUSES.includes(setStatus as (typeof VALID_STATUSES)[number])
      ? setStatus
      : task.status;
  return { from_status: task.status, to_status: toStatus };
}

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
// Status ranking for listings lives in core/task-listing.ts (the ONE
// shared listing model) — no second copy here.

// tryAutoPush lives in `core/operations/git.ts` (the explicit-commit
// operation owns the push effect); the post-review auto-commit path below
// shares it via the operations barrel — one implementation, two callers.

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
 * The `--json` answer for `--next` when there is nothing to hand out — an
 * empty board, or a valid filter that matched no todo task. Both are the SAME
 * situation and deliberately share one payload, so a consumer never has to
 * know which filters it passed.
 *
 * It mirrors a successful claim key for key: `{ok:true, task, next_actions}`.
 * `task: null` is the branch — a claimed task is always an object, so
 * `task === null` answers "did I get a task?" without parsing prose.
 * `next_actions` is `[]` because there is no task to hint about.
 *
 * This is a SUCCESS (exit 0, stdout, `ok:true`), not a refusal: "no work
 * available" is not an error, and it is the same answer on the MCP surface
 * (`claim_next_task` returns a null payload rather than a failure).
 */
function outputNothingToClaim(json: boolean | undefined): void {
  if (!json) return;
  outputEnvelope({
    ok: true,
    json: true,
    payload: { task: null, next_actions: [] },
  });
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

/** True when `abs` is an existing directory — never throws. */
function isDirectorySafe(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
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

/**
 * Mirrors the check zod's `z.string().url()` performs on a task's `url`
 * (trim, then a `new URL()` that must not throw) — the same rule
 * CreateTaskInput applies, so the CLI cannot store a url the MCP surface
 * would refuse. `new URL` throwing is the only failure mode, hence the
 * try/catch rather than a regex that would drift from the parser.
 */
function isParsableUrl(value: string): boolean {
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

// `verify --timeout` bounds, mirroring `VerifyTaskInput.timeoutMs` in
// core/operations.ts (`z.number().min(1000).max(300000).default(60000)`).
// Same unit (milliseconds), same range, same default — the two surfaces must
// not disagree about what a given number means, so these are the CLI copy of
// the MCP field's rule, not a second rule.
const VERIFY_TIMEOUT_MIN_MS = 1_000;
const VERIFY_TIMEOUT_MAX_MS = 300_000;
const VERIFY_TIMEOUT_DEFAULT_MS = 60_000;

/**
 * Parses `vibeflow verify --timeout <ms>`. Anything that is not a whole number
 * of milliseconds inside the range the MCP field accepts is refused with the
 * same E_USAGE envelope + suggestion every other bad flag value uses, before
 * any work starts. `undefined` means "already refused".
 */
function parseVerifyTimeout(
  value: string | undefined,
  json = false,
): number | undefined {
  if (value === undefined) return VERIFY_TIMEOUT_DEFAULT_MS;
  const ms = Number(value.trim());
  if (
    !Number.isInteger(ms) ||
    ms < VERIFY_TIMEOUT_MIN_MS ||
    ms > VERIFY_TIMEOUT_MAX_MS
  ) {
    outputEnvelope({
      ok: false,
      code: "E_USAGE",
      message: `Invalid --timeout: "${value}"`,
      suggestion: `--timeout is whole milliseconds between ${VERIFY_TIMEOUT_MIN_MS} and ${VERIFY_TIMEOUT_MAX_MS} (example: vibeflow verify <task-id> --timeout 90000)`,
      json,
    });
    process.exitCode = ExitCode.USAGE;
    return undefined;
  }
  return ms;
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
  vibeflow changelog [--all]           Show the changelog (latest version / all versions)
  vibeflow openapi [--yaml]            Print the bundled OpenAPI spec (no server needed)

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
  Attach via the CLI (any task type, status is unchanged):
    vibeflow tasks --attach ./plan.md --task <id> [--move]
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
    "--dev",
    "Kanban dev mode: serve the on-disk bundle as a no-store asset + live-reload on rebuild (requires the tsup watch build running alongside; production default is the inlined bundle)",
  )
  .option(
    "--project <dir>",
    "Project root for the task store and MCP server (ignored when an HTML target is given)",
  )
  .action(
    async (
      target: string | undefined,
      opts: { port: string; open: boolean; host?: string; project?: string; dev?: boolean },
    ) => {
      // Coarse mode breakdown: API-only task server (no target — what MCP /
      // script-tag-injection workflows run) vs prototype viewer (an HTML target
      // was given). Only the mode is reported — the target path itself must
      // never reach analytics.
      capture("command_run", {
        surface: "cli",
        command: "serve",
        subcommand: target === undefined ? "api" : "prototype",
      });
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
        // Ticket 7e85c338: explicit opt-in only — never default.
        dev: opts.dev === true,
      });
    },
  );

program
  .command("kanban")
  .description(
    "Start the Vibeflow server and open the live Kanban board in the browser",
  )
  .argument(
    "[dir]",
    "Project root directory (default: $VIBEFLOW_PROJECT_DIR when set, else cwd)",
  )
  .option("-p, --port <port>", "Port number", "3700")
  .option(
    "--host <host>",
    "Bind hostname (default: localhost; use 0.0.0.0 for LAN sharing)",
  )
  .option("--no-open", "Do not open browser automatically")
    .option("--no-changelog", "Do not show the changelog with the update notice")
    .option(
      "--dev",
      "Kanban dev mode: serve the on-disk bundle as a no-store asset + live-reload on rebuild (requires the tsup watch build running alongside; production default is the inlined bundle)",
    )
    .option(
    "--project <dir>",
    "Project root directory (overrides the [dir] positional argument)",
  )
  .action(
    async (
      dir: string | undefined,
      opts: {
        port: string;
        host?: string;
        open: boolean;
        changelog: boolean;
        project?: string;
        dev?: boolean;
      },
    ) => {
      capture("command_run", { surface: "cli", command: "kanban" });
      await flushTelemetry();
      // Explicit --project / positional wins; $VIBEFLOW_PROJECT_DIR fills
      // the default inside resolveProjectRoot (b5f90a1e scratch-store boot).
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
        // Ticket 7e85c338: explicit opt-in only — never default.
        dev: opts.dev === true,
      });
      const kanbanUrl = instance.url + "/kanban";
      // The ready block + agent prompt come from the ONE guide builder
      // (server/startup-guide.ts) — the same lines `start_kanban` returns.
      printGuideLines(
        buildKanbanReadyLines(
          buildIntegrationGuide({ url: instance.url, localUrl: instance.localUrl ?? null }),
        ),
      );
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
  .option(
    "--relates <task-id>",
    "Add a relates link (use with --edit; repeatable; additive — every other link is preserved; full ID or prefix)",
    (val, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--blocks <task-id>",
    "Add a blocks link (use with --edit; repeatable; additive — every other link is preserved; full ID or prefix)",
    (val, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--unrelates <task-id>",
    "Remove one relates link (use with --edit; repeatable; every other link is preserved)",
    (val, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    "--unblocks <task-id>",
    "Remove one blocks link (use with --edit; repeatable; every other link is preserved)",
    (val, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--json", "Output machine-readable JSON")
  .option(
    "--commit",
    "Commit staged changes and link the commit SHA to a task (use with --task)",
  )
  .option(
    "--task <task-id>",
    "Task ID (use with --commit to link, or with --attach to choose the target task; supports partial ID prefix)",
  )
  .option(
    "--attach <path>",
    "Attach a file to a task without changing its status (use with --task; any task type, unlike Research-only --report-file). The source file is kept — pass --move to delete it after a successful attach. The same (task, name) pair is never uploaded twice: re-attaching an existing filename is refused",
  )
  .option(
    "--move",
    "Delete the source file after a successful attach (use with --attach; kept by default)",
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
    "Commit message for auto-commit on review (required when auto-commit setting is ON — checked first, before anything else runs)",
  )
  .option(
    "--get <task-id>",
    "Get full details of a single task by ID (supports partial ID prefix)",
  )
  .option(
    "--delete <task-id>",
    "Delete a task by ID (supports partial ID prefix; refused without --yes; --yes --dry-run only previews, deleting nothing). A LOCAL parent with children is refused — delete the children first. The ONLINE delete cascades: descendants go with the parent (named in the preview) and matching local records are dropped so push cannot recreate them",
  )
  .option(
    "--yes",
    "Confirm a destructive operation (use with --delete; without it the command only previews what would be deleted)",
  )
  .option(
    "--next",
    "Pick the next todo task, move it to in-progress, and output it ready to work on (prefers the highest-priority ROOT task; when no todo root is claimable, claims the highest-priority matching todo child and says so explicitly — a todo child of a non-todo parent is never skipped silently; the root's children are reported alongside a root claim)",
  )
  .option(
    "--children",
    "Include child tasks in the unfiltered listing. By default only ROOT tasks are listed — a child belongs to its parent, matching the board. Filtered listings (--status/--type/--tag/--user) always include every matching child with parent context. Has no effect with --next, which prefers roots and falls back to a todo child of live work (parent chain todo/in-progress/review) only when no todo root is claimable — children of backlog/done parents are refused and reported, never claimed. Takes no ID — to inspect one task's children, use --get <id>.",
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
    // The number lives in exactly one place: DEFAULT_LIST_LIMIT in api-core
    // (ticket 9bb350a7) — the MCP `limit` schema defaults to the same
    // constant, so the two surfaces cannot drift. Ticket b2e56212: 0 is NOT
    // an unbounded mode — it resolves to the default LOUDLY (named in the
    // --json envelope as `limitNotice`); use --all for everything.
    `Limit how many tasks are returned in list mode (default: ${DEFAULT_LIST_LIMIT}; 0 is not supported and resolves to the default — use --all for everything)`,
  )
  .option(
    "--all",
    "Fetch every matching task in the current scope in list mode (combine with --children for the unfiltered whole board), paging internally with bounded requests (unbounded overall, bounded per request — no single unbounded read). The --json envelope reports the assembled set with truncated:false, remaining:0 and nextCursor:null.",
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
    "--normalize",
    "Store maintenance: repair record artifacts, comment aliases and null optional scalars; report unrepairable records without deleting deliberate data (dry-run by default; add --apply to write; idempotent; honors --json)",
  )
  .option(
    "--apply",
    "Write the --normalize plan to the store (without it, --normalize only reports what it would change)",
  )
  .option(
    "--fields <fields>",
    "Comma-separated list of fields to include in output (list/get modes)",
  )
  .option(
    "--priority <priority>",
    "Task priority (Critical, High, Medium, Low) — use with --add",
  )
  // An annotated task (url + selector) is what the overlay produces and what
  // `vibeflow verify` needs to re-find the element; without these three flags
  // `--add` could only ever write an unannotated task. Symmetric with
  // create_task's url/selector/sortKey on the MCP surface.
  .option(
    "--url <url>",
    "Page URL the annotation targets (use with --add) — pair with --selector to create an annotated task",
  )
  .option(
    "--selector <selector>",
    "Selector of the annotated element (use with --add; defaults to \"/\")",
  )
  .option(
    "--sort-key <key>",
    "Explicit ordering key for the new task (use with --add; core auto-assigns one when omitted)",
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
        delete?: string;
        yes?: boolean;
        next?: boolean;
        children?: boolean;
        task?: string;
        message?: string;
        comment?: string;
        commitMessage?: string;
        attach?: string;
        move?: boolean;
        reportFile?: string;
        branch?: string;
        limit?: string;
        // --all is list-only: fetch the whole matching set through the
        // explicit paged helper (ticket b2e56212), never a magic limit.
        all?: boolean;
        tag?: string[];
        // Repeatable link flags. All four default to [] via the commander
        // parser, so the edit path can read .length without a guard — but the
        // type stays optional because the same opts object is shared with the
        // list/get paths where they are never set.
        relates?: string[];
        blocks?: string[];
        unrelates?: string[];
        unblocks?: string[];
        dryRun?: boolean;
        fields?: string;
        setVerify?: "pass" | "fail" | "cannot";
        verifyReason?: string;
        priority?: string;
        // --add-only annotation fields. Optional because the same opts object
        // is shared with the list/get/edit paths, which never read them.
        url?: string;
        selector?: string;
        sortKey?: string;
        reindexSortKeys?: boolean;
        // Schema-boundary maintenance (see the --normalize handler):
        // dry-run by default, --apply writes.
        normalize?: boolean;
        apply?: boolean;
      },
    ) => {
      async function runTasks() {
        // Determine sub-command for telemetry before async operations
        const taskSubcommand = opts.add
          ? "add"
          : opts.delete !== undefined
            ? "delete"
            : opts.next
              ? "next"
              : opts.attach !== undefined
                ? "attach"
                : opts.edit
                  ? "edit"
                  : opts.get
                    ? "get"
                    : opts.reindexSortKeys
                      ? "reindex"
                      : opts.normalize
                        ? "normalize"
                        : "list";
        capture("command_run", {
          surface: "cli",
          command: "tasks",
          subcommand: taskSubcommand,
          // Edit events carry the status pair so a real status funnel
          // (created → in-progress → review → done) is queryable; every
          // other subcommand stays a two-property payload.
          ...(taskSubcommand === "edit"
            ? editStatusTelemetryProps(resolve(dir), opts.edit, opts.setStatus)
            : {}),
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

        // ── --delete is exclusive ───────────────────────────────────────
        // Deleting while also adding/editing/reading would leave the
        // preview and the write disagreeing about which task exists, so
        // the combination is refused before anything is resolved.
        if (
          opts.delete !== undefined &&
          (opts.add ||
            opts.edit !== undefined ||
            opts.get ||
            opts.next ||
            opts.commit ||
            opts.reindexSortKeys ||
            opts.normalize)
        ) {
          outputEnvelope({ ok: false,
            code: "E_USAGE",
            message:
              "--delete cannot be combined with --add/--edit/--get/--next/--commit/--reindex-sort-keys/--normalize",
            json: opts.json,
          });
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // ── --yes requires --delete ─────────────────────────────────────
        // --yes confirms a destructive operation and names no task itself;
        // without --delete there is nothing to confirm, so it is refused
        // rather than silently accepted and ignored.
        if (opts.yes && opts.delete === undefined) {
          outputEnvelope({ ok: false,
            code: "E_USAGE",
            message: "--yes is only valid with --delete",
            suggestion:
              'Example: vibeflow tasks --delete <id> --yes',
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

        // ── --attach is exclusive (standalone attach mode) ─────────────
        // Attaching while also adding/editing/reading/deleting would leave
        // the preview and the write disagreeing about which task exists, so
        // the combination is refused before anything is resolved.
        if (
          opts.attach !== undefined &&
          (opts.add ||
            opts.edit !== undefined ||
            opts.get ||
            opts.next ||
            opts.commit ||
            opts.delete !== undefined ||
            opts.reindexSortKeys ||
            opts.normalize)
        ) {
          outputEnvelope({ ok: false,
            code: "E_USAGE",
            message:
              "--attach cannot be combined with --add/--edit/--get/--next/--commit/--delete/--reindex-sort-keys/--normalize",
            json: opts.json,
          });
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // ── --move requires --attach ───────────────────────────────────
        // --move names no file itself; without --attach there is nothing to
        // consume, so it is refused rather than silently accepted and ignored.
        if (opts.move && opts.attach === undefined) {
          outputEnvelope({ ok: false,
            code: "E_USAGE",
            message: "--move is only valid with --attach <path>",
            suggestion:
              'Example: vibeflow tasks --attach ./plan.md --task <id> --move',
            json: opts.json,
          });
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // ── --attach requires --task ───────────────────────────────────
        // The [dir] positional is the project root, never a task selector —
        // the target task is always named explicitly so an attach can never
        // land on a task the caller did not name.
        if (opts.attach !== undefined && !opts.task?.trim()) {
          outputEnvelope({ ok: false,
            code: "E_USAGE",
            message: "--attach needs --task <task-id>",
            suggestion:
              'Example: vibeflow tasks --attach ./plan.md --task <id>',
            json: opts.json,
          });
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // ── --children takes no task ID ──────────────────────────────────
        // --children is a boolean listing FLAG. `tasks --children <id>`
        // parses the id as the [dir] positional, so the CLI used to list a
        // directory named after the task (which holds no store) and print
        // "No tasks found" with exit 0 — reading exactly like a broken
        // parent link. Fail loudly instead, naming the flag and the command
        // that actually inspects one task's children. Scoped to list mode
        // with a non-default positional that is not an existing directory,
        // so `tasks <project-dir> --children` keeps working.
        if (
          taskSubcommand === "list" &&
          opts.children &&
          dir !== "." &&
          !isDirectorySafe(resolve(dir))
        ) {
          outputEnvelope({ ok: false,
            code: "E_USAGE",
            message: `--children is a listing flag and does not take a task ID (got "${dir}")`,
            suggestion:
              'To inspect one task\'s children, use `vibeflow tasks --get <id>` (its output ends with "children (n):"). To include children in a listing, use `vibeflow tasks --children` with no ID.',
            json: opts.json,
          });
          process.exitCode = ExitCode.USAGE;
          return;
        }

        // ── Reindex sort keys (one-time maintenance) ────────────────────────
        // Re-key the tasks the comparator cannot order (keyless / 'n' / same-
        // column duplicates) without touching the well-formed, column-unique
        // keys around them. Flag parsing and the gates above stay here; every
        // effect — planning, minimal writes, the manifest, the post-assert —
        // runs in the shared `reindexTaskSortKeys` operation
        // (core/operations/maintenance.ts), so the CLI and any future caller
        // cannot disagree on what gets re-keyed. The renderer below performs
        // no store reads of its own.
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
          const reindexOpCtx: OperationContext = {
            projectDir: resolve(dir),
            mode: "local",
          };
          const reindexResult = await operations.reindexTaskSortKeys(reindexOpCtx, {
            ...(opts.dryRun ? { dryRun: true } : {}),
          });
          if (!reindexResult.ok) {
            const reindexErr = reindexResult.error;
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: reindexErr.code,
                message: reindexErr.message,
                ...(reindexErr.suggestion
                  ? { suggestion: reindexErr.suggestion }
                  : {}),
                json: opts.json,
              });
            } else {
              console.log(chalk.red(`✗ ${reindexErr.message}`));
              if (reindexErr.suggestion)
                console.log(chalk.dim(`  ${reindexErr.suggestion}`));
            }
            process.exitCode = ExitCode.GENERAL;
            return;
          }
          const reindexed = reindexResult.data;
          // The JSON document carries the manifest shape (id/oldKey/newKey);
          // titles ride the human lines only.
          const reindexManifest = reindexed.patches.map((m) => ({
            id: m.id,
            oldKey: m.oldKey,
            newKey: m.newKey,
          }));

          if (reindexed.dryRun) {
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  dryRun: true,
                  count: reindexManifest.length,
                  anchorRule:
                    "whole-store unique keys (a key duplicated anywhere is re-keyed)",
                  patches: reindexManifest,
                },
              });
            } else {
              console.log(
                chalk.yellow(
                  `  [dry-run] Would reindex ${reindexManifest.length} task sortKey(s):`,
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
              for (const m of reindexed.patches) {
                console.log(
                  chalk.dim(`    ${m.id}  ${m.title}`),
                );
                console.log(
                  chalk.dim(`      ${m.oldKey ?? "(none)"} → ${m.newKey}`),
                );
              }
            }
            return;
          }

          if (opts.json) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                reindexVerified: reindexed.reindexVerified,
                written: reindexed.written,
                manifestPath: reindexed.manifestPath,
                remainingKeyless: reindexed.keyless,
                sameColumnDuplicateGroups: reindexed.dupOffenders.length,
                patches: reindexManifest,
                ...noticeFields(reindexed.notices),
              },
            });
          } else if (reindexed.reindexVerified) {
            console.log(
              chalk.green(
                `✓ Reindexed ${reindexed.written} task sortKey(s); 0 keyless, 0 same-column duplicate groups.`,
              ),
            );
            console.log(
              chalk.dim(
                "  Anchor rule: whole-store unique keys — a key duplicated anywhere is re-keyed, so mixed-status sibling groups keep their order. See docs/plans/sortkey-fix.md §7.",
              ),
            );
            console.log(chalk.dim(`  manifest: ${reindexed.manifestPath}`));
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
                `⚠ Reindex incomplete: ${reindexed.keyless} keyless (${reindexed.openKeyless} open), ${reindexed.dupOffenders.length} same-column duplicate group(s).`,
              ),
            );
            for (const o of reindexed.dupOffenders) console.log(chalk.dim(`    ${o}`));
          }
          return;
        }

        // Closed repairs share the read boundary; unknown/conflicting data
        // remains quarantined. Dry-run by default, explicit --apply to heal.
        // Flag parsing and the gates above stay here; the preview/apply
        // effects run in the shared `normalizeTaskStore` operation
        // (core/operations/maintenance.ts) — a preview never writes, even
        // with `--apply --dry-run` (dryRun overrides apply). The renderer
        // below performs no store reads of its own.
        if (opts.normalize) {
          if (
            opts.add ||
            opts.edit !== undefined ||
            opts.get ||
            opts.next ||
            opts.commit ||
            opts.reindexSortKeys
          ) {
            outputEnvelope({ ok: false,
              code: "E_USAGE",
              message:
                "--normalize cannot be combined with --add/--edit/--get/--next/--commit/--reindex-sort-keys",
              json: opts.json,
            });
            process.exitCode = ExitCode.USAGE;
            return;
          }
          const projectDir = resolve(dir);
          const describeChange = (c: { field: string; before: unknown; after: unknown }): string =>
            `${c.field}: ${JSON.stringify(c.before) ?? "absent"} → ${JSON.stringify(c.after)}`;
          const changeJson = (p: {
            id: string;
            changes: Array<{ field: string; before: unknown; after: unknown }>;
          }): Record<string, unknown> => ({
            id: p.id,
            changes: p.changes.map((c) => ({
              field: c.field,
              before: c.before === undefined ? null : c.before,
              after: c.after,
            })),
          });
          const normalizeOpCtx: OperationContext = {
            projectDir,
            mode: "local",
          };
          const normalizeResult = await operations.normalizeTaskStore(normalizeOpCtx, {
            ...(opts.apply ? { apply: true } : {}),
            ...(opts.dryRun ? { dryRun: true } : {}),
          });
          if (!normalizeResult.ok) {
            const normalizeErr = normalizeResult.error;
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: normalizeErr.code,
                message: normalizeErr.message,
                ...(normalizeErr.suggestion
                  ? { suggestion: normalizeErr.suggestion }
                  : {}),
                json: opts.json,
              });
            } else {
              console.log(chalk.red(`✗ ${normalizeErr.message}`));
              if (normalizeErr.suggestion)
                console.log(chalk.dim(`  ${normalizeErr.suggestion}`));
            }
            process.exitCode = ExitCode.GENERAL;
            return;
          }
          const normalized = normalizeResult.data;
          const normalizeNotices = normalized.notices;
          if (normalized.dryRun) {
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  dryRun: true,
                  count: normalized.plans.length,
                  changes: normalized.plans.map(changeJson),
                  unreadable: normalized.unreadable,
                  quarantined: normalized.quarantined,
                  ...noticeFields(normalizeNotices),
                },
              });
            } else if (normalized.plans.length === 0) {
              console.log(
                chalk.green("✓ Store already normalized: 0 changes."),
              );
            } else {
              console.log(
                chalk.yellow(
                  `  [dry-run] Would normalize ${normalized.plans.length} task(s):`,
                ),
              );
              for (const p of normalized.plans) {
                console.log(chalk.dim(`    ${p.id}`));
                for (const c of p.changes) {
                  console.log(chalk.dim(`      ${describeChange(c)}`));
                }
              }
              console.log(chalk.dim("  Re-run with --apply to write."));
            }
            if (!opts.json) {
              for (const notice of normalizeNotices) console.error(notice.message);
              for (const f of normalized.unreadable) {
                console.log(chalk.dim(`  skipped unreadable file: ${f}`));
              }
            }
            return;
          }
          if (!opts.json) for (const notice of normalizeNotices) console.error(notice.message);
          if (opts.json) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                dryRun: false,
                written: normalized.plans.length,
                changes: normalized.plans.map(changeJson),
                unwritten: normalized.unwritten,
                unreadable: normalized.unreadable,
                quarantined: normalized.quarantined,
                ...noticeFields(normalizeNotices),
              },
            });
          } else if (normalized.plans.length === 0) {
            console.log(
              chalk.green("✓ Store already normalized: 0 changes."),
            );
          } else {
            console.log(
              chalk.green(
                `✓ Normalized ${normalized.plans.length} task(s): declared record repairs applied; other values preserved.`,
              ),
            );
            for (const p of normalized.plans) {
              console.log(chalk.dim(`    ${p.id}`));
              for (const c of p.changes) {
                console.log(chalk.dim(`      ${describeChange(c)}`));
              }
            }
            for (const id of normalized.unwritten) {
              console.log(chalk.yellow(`  ⚠ unwritten: ${id}`));
            }
          }
          return;
        }

        // ── Delete mode ────────────────────────────────────────────────
        // `tasks --delete <id> [--yes]` removes one task. Flag parsing and
        // the gates above stay here; every effect — resolution, the child
        // guard, the online cascade, the local clone cleanup — runs in the
        // shared `deleteTaskOperation` (core/operations/delete.ts), so the
        // two stores cannot disagree about what a prefix names. There is no
        // MCP delete tool by design (a destructive loop footgun), so the
        // operation is CLI-only — but it is still shared-layer code, and
        // the renderer below performs no store reads of its own.
        if (opts.delete !== undefined) {
          const deleteRawId =
            typeof opts.delete === "string" ? opts.delete : "";
          const deleteProjectDir = resolve(dir);
          const deleteIsOnline = (await getMode()) === "saas";
          const deleteOpCtx: OperationContext = {
            projectDir: deleteProjectDir,
            mode: deleteIsOnline ? "saas" : "local",
          };
          const deleteResult = await operations.deleteTaskOperation(deleteOpCtx, {
            id: deleteRawId,
            confirmed: opts.yes === true,
            ...(opts.dryRun ? { dryRun: true } : {}),
          });
          if (!deleteResult.ok) {
            const deleteErr = deleteResult.error;
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: deleteErr.code,
                message: deleteErr.message,
                ...(deleteErr.suggestion
                  ? { suggestion: deleteErr.suggestion }
                  : {}),
                ...(deleteErr.retryable !== undefined
                  ? { retryable: deleteErr.retryable }
                  : {}),
                json: opts.json,
              });
            } else if (
              deleteErr.code === "CONFIRM_REQUIRED" &&
              deleteErr.preview
            ) {
              // The itemized preview block: what would be deleted, and —
              // for a parent — every descendant the online delete would
              // cascade through (or the dangling children a local delete
              // refuses to orphan).
              const preview = deleteErr.preview;
              const childLines = preview.children.map(
                (c) => `      • ${c.id} ${c.title}`,
              );
              const deeperCount =
                preview.descendants.length - preview.children.length;
              console.log(chalk.yellow("  Would delete task:"));
              console.log(chalk.dim(`    id:     ${preview.id}`));
              if (preview.title)
                console.log(chalk.dim(`    title:  ${preview.title}`));
              if (preview.status)
                console.log(chalk.dim(`    status: ${preview.status}`));
              if (preview.online && preview.descendants.length > 0) {
                console.log(
                  chalk.red(
                    `    ⚠ CASCADE: deleting this parent deletes ${preview.descendants.length} descendant task${preview.descendants.length === 1 ? "" : "s"} with it (the v0 DELETE cascades):`,
                  ),
                );
                for (const line of childLines) console.log(chalk.dim(line));
                if (deeperCount > 0)
                  console.log(
                    chalk.dim(
                      `      …plus ${deeperCount} deeper descendant${deeperCount === 1 ? "" : "s"} (the server deletes the whole cone)`,
                    ),
                  );
              } else if (preview.children.length > 0) {
                console.log(
                  chalk.red(
                    `    ✗ has ${preview.children.length} child task${preview.children.length === 1 ? "" : "s"} — deleting the parent would leave them with a dangling parent link:`,
                  ),
                );
                for (const line of childLines) console.log(chalk.dim(line));
                console.log(
                  chalk.dim(
                    "    Delete the children first (deepest first), then re-run with --yes.",
                  ),
                );
              } else {
                console.log(chalk.dim("    Re-run with --yes to delete."));
              }
            } else {
              console.log(chalk.red(`✗ ${deleteErr.message}`));
              if (deleteErr.suggestion)
                console.log(chalk.dim(`  ${deleteErr.suggestion}`));
              if (
                deleteErr.code === "HAS_CHILDREN" &&
                deleteErr.preview
              ) {
                for (const c of deleteErr.preview.children)
                  console.log(chalk.dim(`      • ${c.id} ${c.title}`));
              }
            }
            process.exitCode =
              deleteErr.code === "TASK_NOT_FOUND" ||
              deleteErr.code === "E_NOT_FOUND"
                ? ExitCode.NOT_FOUND
                : deleteErr.code === "E_AMBIGUOUS" ||
                    deleteErr.code === "E_USAGE"
                  ? ExitCode.USAGE
                  : ExitCode.GENERAL;
            return;
          }
          const deleted = deleteResult.data;
          if (deleted.dryRun) {
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  dryRun: true,
                  id: deleted.id,
                  deletedIds: deleted.deletedIds,
                },
              });
            } else {
              console.log(
                chalk.yellow(
                  `  [dry-run] Would delete task ${deleted.id}${deleted.title ? ` "${deleted.title}"` : ""} — nothing was deleted.`,
                ),
              );
              if (deleteIsOnline && deleted.deletedIds.length > 1)
                console.log(
                  chalk.yellow(
                    `  [dry-run] CASCADE: ${deleted.deletedIds.length - 1} descendant task${deleted.deletedIds.length - 1 === 1 ? "" : "s"} would go with it: ${deleted.deletedIds.slice(1).join(", ")}`,
                  ),
                );
            }
            return;
          }
          if (opts.json) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                deleted: true,
                id: deleted.id,
                deletedIds: deleted.deletedIds,
              },
            });
          } else {
            console.log(chalk.green(`✓ Task deleted: ${deleted.title}`));
            console.log(chalk.dim(`  id: ${deleted.id}`));
            if (deleteIsOnline && deleted.deletedIds.length > 1) {
              console.log(
                chalk.yellow(
                  `  ⚠ Online cascade: ${deleted.deletedIds.length - 1} descendant task${deleted.deletedIds.length - 1 === 1 ? "" : "s"} deleted with it: ${deleted.deletedIds.slice(1).join(", ")}`,
                ),
              );
            }
          }
          return;
        }

        // ── Get single task mode ───────────────────────────────────────
        // P2 (ticket d7b9dc13): reads through the operations layer. Local
        // get resolves through the get_task operation (same authority and
        // ports as MCP get_task); remote get reads through the remote
        // port's detail-first resolveTask below, NOT the relation-deriving
        // operation — the pinned `--get` contract (one detail request,
        // raw detail shape passing through: see
        // tests/unit/commands/saas-get-relations.test.ts) forbids both the
        // operation's second (relations) request and its mapped rows. The
        // remote branch never touches local files, so the phantom class
        // (stale local data presented as current) cannot occur there;
        // envelopes and exit codes for BOTH modes are assembled by
        // `cli/renderers/task-reads.ts`.
        if (opts.get) {
          const getTaskMode = await getMode();
          const getOpCtx: OperationContext = {
            projectDir: resolve(dir),
            mode: getTaskMode === "saas" ? "saas" : "local",
          };
          const getFields = opts.fields
            ? opts.fields
                .split(",")
                .map((f: string) => f.trim())
                .filter(Boolean)
            : [];
          if (resolveReadBackend(getTaskMode) === "remote") {
            // One detail request — never a (hydrated) whole-board fetch.
            // A 404 falls back to an UNHYDRATED listing for prefix
            // resolution only (--get accepts a unique prefix, resolved by
            // the ONE resolver `resolveSaasTaskId`: exact id wins, a unique
            // prefix resolves, an ambiguous prefix is E_AMBIGUOUS naming
            // the candidates — never a silent first-match); the matched
            // full id is then read back as one detail request. Any online
            // failure is reported with its status/path — the run never
            // silently falls back to the local store.
            const reportSaasReadError = (error: {
              code: string;
              message: string;
              status?: number;
              path?: string;
              serverCode?: string;
            }) => {
              const message = saasReadErrorMessage(error);
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  ...saasFailure(error),
                  message,
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ ${message}`));
              }
              process.exitCode = ExitCode.GENERAL;
            };
            const detail = await fetchSaasTaskDetail(opts.get);
            let saasTask: SaasTask | undefined;
            if (detail.ok) {
              saasTask = detail.data.task;
            } else if (detail.error.code !== "TASK_NOT_FOUND") {
              reportSaasReadError(detail.error);
              return;
            } else {
              const workspace = await readWorkspace();
              const board = await fetchSaasTasks(workspace?.id, {
                hydrate: false,
              });
              if (!board.ok) {
                reportSaasReadError(board.error);
                return;
              }
              const prefixResolved = resolveSaasTaskId(
                board.data.tasks,
                opts.get!,
              );
              if (!prefixResolved.ok) {
                if (prefixResolved.code === "E_AMBIGUOUS") {
                  if (opts.json) {
                    outputEnvelope({
                      ok: false,
                      code: prefixResolved.code,
                      message: prefixResolved.message,
                      suggestion:
                        "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                      json: opts.json,
                    });
                  } else {
                    console.log(chalk.red(`✗ ${prefixResolved.message}`));
                    console.log(
                      chalk.dim(
                        "  Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                      ),
                    );
                  }
                  process.exitCode = ExitCode.USAGE;
                  return;
                }
                // TASK_NOT_FOUND: leave saasTask unset and fall through
                // to the TASK_NOT_FOUND branch below.
              } else {
                const match = board.data.tasks.find(
                  (t) => t.id === prefixResolved.id,
                );
                if (match && match.id !== opts.get) {
                  const resolved = await fetchSaasTaskDetail(match.id);
                  if (!resolved.ok) {
                    // A 404 here (deleted between the two reads) is still a
                    // miss: leave saasTask unset and fall through to the
                    // TASK_NOT_FOUND branch below.
                    if (resolved.error.code !== "TASK_NOT_FOUND") {
                      reportSaasReadError(resolved.error);
                      return;
                    }
                  } else {
                    saasTask = resolved.data.task;
                  }
                } else if (match) {
                  // Exact id answered 404 above but the listing carries it
                  // (read-after-write race): render the listed row as-is.
                  saasTask = match;
                }
              }
            }
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
                // The detail contract (ticket 086b40aa) travels in the
                // envelope ONLY as the server sent it: a key the response
                // did not carry stays absent — never synthesised to
                // null/[] (a listing-row fallback has links[] but no
                // detail-relation fields, and null/children:[] would assert
                // facts the server never sent). (Local MCP get_task already
                // merges derived relations in operations.getTask — nothing
                // to change there.)
                payload: {
                  task: {
                    ...saasTask,
                    status: cliStatus,
                    ...(saasTask.parentId !== undefined
                      ? { parentId: saasTask.parentId }
                      : {}),
                    ...(saasTask.children !== undefined
                      ? { children: saasTask.children }
                      : {}),
                  },
                },
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
                    `      [${c.author ?? "agent"}] ${c.createdAt}`,
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
                // Cloud-only URL: getApiUrl() is the SaaS base → always
                // "cloud", so the legacy files path maps to /api/v0.
                const fileUrl =
                  f.url ??
                  `${getApiUrl()}${surfacePath("cloud", `/api/tasks/${saasTask.id}/files/${encodeURIComponent(f.name)}`)}`;
                console.log(chalk.dim(`      - ${f.name}  ${fileUrl}`));
                if (f.content) {
                  console.log(chalk.dim(`        ┌── content ──`));
                  for (const line of f.content.split("\n"))
                    console.log(chalk.dim(`        │  ${line}`));
                  console.log(chalk.dim(`        └─────────────`));
                }
              }
            }
            // ONLINE relations (ticket 086b40aa): rendered from the DETAIL
            // RESPONSE alone — one detail request, never a board listing or a
            // second fetch. A response carrying neither field may be an older
            // server OR the listing-row fallback (an exact-id 404 answered
            // from a current listing, which carries no detail relations) —
            // the cause is unproven, so one dim cause-neutral line says the
            // relations are unavailable in this response, never silence.
            if (!hasSaasDetailRelations(saasTask)) {
              console.log(
                chalk.dim(`    relations unavailable in this response`),
              );
            } else {
              for (const line of formatSaasDetailRelations(saasTask))
                console.log(chalk.dim(`    ${line}`));
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

          // ── Local mode: through the get_task operation ──────────────
          // Existence, prefix rule, and relations come from the operation
          // (same ports as MCP get_task). The one-id rule is enforced in
          // the local port itself now, so an ambiguous prefix refuses
          // here exactly as it does on the remote path.
          const getResult = await operations.getTask(getOpCtx, {
            id: opts.get!,
            ...(getFields.length > 0 ? { fields: getFields } : {}),
          });
          if (!getResult.ok) {
            const refusal = operationRefusalEnvelope(getResult.error);
            if (opts.json) {
              outputEnvelope({ ...refusal, json: opts.json });
            } else {
              console.log(chalk.red(`✗ ${refusal.message}`));
              if (refusal.suggestion) {
                console.log(chalk.dim(`  ${refusal.suggestion}`));
              }
            }
            process.exitCode = refusalExitCode(getResult.error.code);
            return;
          }
          const projectDir = resolve(dir);
          const config = readConfig(projectDir);
          const task = getResult.data as Task;
          // Mark task as opened by current user
          const currentUser = getCurrentUserId();
          markTaskOpened(projectDir, task.id, currentUser);

          // Display details through the read ports — the same authority
          // the operation read.
          const { store: getDisplayStore } = resolveReadPorts(getOpCtx);
          const structuredComments = (
            await getDisplayStore.listComments(projectDir, task.id)
          ).sort(sortByCreatedAt);
          const linkedFiles = (
            await getDisplayStore.listFiles(projectDir, task.id)
          ).map((f) => ({
            ...f,
            url: `http://localhost:${config.port}${f.url}`,
          }));
          if (opts.json) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: localGetJsonPayload(task, getFields, {
                comments: structuredComments,
                files: linkedFiles,
              }),
            });
            return;
          }
          const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
          const allTasks = await getDisplayStore.listTasks(projectDir);
          const agentMessage = renderTaskForAgent(
            task,
            findTaskFilePath(projectDir, task.id) ?? "(unknown)",
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
            // P3 (ticket 6452504d): the online claim goes through the shared
            // claimNextTask operation — exactly ONE versioned agent-claim
            // POST whose selection and write the server owns — never a
            // client-side list-then-PATCH. That read-then-write raced (two
            // agents could take the same task), ignored blockers/ancestry,
            // and could report success the remote refused.
            const nextSaasDir = resolve(dir);
            const nextSaasCtx: OperationContext = {
              projectDir: nextSaasDir,
              mode: "saas",
              userId: getGitUser(nextSaasDir).name,
            };
            if (opts.type && !validateTypeFilter(opts.type, opts.json)) return;
            if (opts.user) {
              // The user hint still names unknown authors before claiming:
              // one unhydrated snapshot through the read ports (the same
              // authority the claim resolves through).
              const { store: nextSaasScopeStore } =
                resolveReadPorts(nextSaasCtx);
              const nextSaasScope = await nextSaasScopeStore.listTasks(
                nextSaasDir,
              );
              if (!validateUserFilter(opts.user, nextSaasScope, opts.json))
                return;
            }
            const nextSaasClaim = await operations.claimNextTask(
              nextSaasCtx,
              {
                type: opts.type as ClaimNextTaskInputType["type"],
                user: opts.user,
                tag: opts.tag,
                dryRun: opts.dryRun === true,
              },
            );
            if (!nextSaasClaim.ok) {
              // A remote refusal travels verbatim (old-server, auth, scope,
              // transport) — never relabelled, never worked around.
              const refusal = operationRefusalEnvelope(nextSaasClaim.error);
              if (opts.json) {
                outputEnvelope({ ...refusal, json: opts.json });
              } else {
                console.log(chalk.red(`✗ ${refusal.message}`));
                if (refusal.suggestion) {
                  console.log(chalk.dim(`  ${refusal.suggestion}`));
                }
              }
              process.exitCode = refusalExitCode(nextSaasClaim.error.code);
              return;
            }
            const nextTask = nextSaasClaim.data;
            const nextSaasIsDryRun = opts.dryRun === true;
            const nextSaasChildClaim = (nextSaasClaim.steps ?? []).some(
              (s) => s.code === "CHILD_CLAIM",
            );
            if (!nextTask) {
              // "No work available" is a SUCCESS on both surfaces, so the
              // filter hints stay a human-mode nicety and the machine answer
              // is the SAME payload the local path emits.
              outputNothingToClaim(opts.json);
              if (opts.json) return;
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

            const nextSaasNextActions = nextSaasIsDryRun
              ? []
              : getNextActions("set-status:in-progress", nextTask.id);
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  task: nextTask,
                  next_actions: nextSaasNextActions,
                  childClaim: nextSaasChildClaim,
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

            // The claimed record arrives through the shared operation in the
            // local Task shape (mapped from the online row, status already
            // in-progress — a dry-run preview stays todo, which is how a
            // consumer tells nothing was written).
            console.log(
              nextSaasIsDryRun
                ? chalk.green.bold(
                    "▶ WOULD CLAIM (dry-run — nothing was written):",
                  )
                : chalk.green.bold(
                    "▶ NEXT TASK — Status moved to in-progress. Implement this now:",
                  ),
            );
            console.log();
            console.log(
              `  ${chalk.blue(`[${nextTask.status}]`)} ${chalk.bold(nextTask.title)}`,
            );
            console.log(chalk.dim(`    id:       ${nextTask.id}`));
            if (nextTask.type)
              console.log(chalk.dim(`    type:     ${nextTask.type}`));
            if (nextTask.priority)
              console.log(chalk.dim(`    priority: ${nextTask.priority}`));
            console.log(chalk.dim(`    created:  ${nextTask.created}`));
            if (nextSaasChildClaim) {
              const saasParentId = (nextTask.links ?? []).find(
                (l) => l.type === "parent",
              )?.taskId;
              console.log(
                chalk.yellow(
                  `  ⤷ CHILD CLAIM — no todo root was available, so this claims a todo child${saasParentId ? ` of ${saasParentId.slice(0, 8)}` : ""}.`,
                ),
              );
            }
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
                console.log(chalk.dim(`      [${c.author}] ${c.createdAt}`));
                for (const line of c.text.split("\n"))
                  console.log(chalk.dim(`        ${line}`));
              }
            }
            console.log();
            if (!nextSaasIsDryRun) {
              console.log(
                chalk.yellow(
                  "  ⚡ This task is already in-progress. Implement it now and mark as review when done.",
                ),
              );
              printNextHint(nextSaasNextActions);
            }
            return;
          }

          // ── Local next mode ──────────────────────────────────────────────
          // P3 (ticket 6452504d): the claim goes through the shared
          // claimNextTask operation (same primitive the MCP tool calls),
          // and the blocked/stranded/children context below derives from a
          // board snapshot read through the operation's ports — never a
          // second store read at this surface. The --user empty-list
          // validation pin (tasks-json-refusals) is preserved verbatim.
          const nextProjectDir = resolve(dir);
          if (opts.type && !validateTypeFilter(opts.type, opts.json)) return;
          if (opts.user && !validateUserFilter(opts.user, [], opts.json)) return;

          const nextClaimFilter = {
            type: opts.type as ClaimNextTaskInputType["type"],
            user: opts.user,
            tag: opts.tag,
          };
          const nextCtx: OperationContext = {
            projectDir: nextProjectDir,
            mode: "local",
            userId: getGitUser(nextProjectDir).name,
          };
          const nextIsDryRun = opts.dryRun === true;
          const nextClaim = await operations.claimNextTask(nextCtx, {
            ...nextClaimFilter,
            dryRun: nextIsDryRun,
          });
          if (!nextClaim.ok) {
            const refusal = operationRefusalEnvelope(nextClaim.error);
            if (opts.json) {
              outputEnvelope({ ...refusal, json: opts.json });
            } else {
              console.log(chalk.red(`✗ ${refusal.message}`));
              if (refusal.suggestion) {
                console.log(chalk.dim(`  ${refusal.suggestion}`));
              }
            }
            process.exitCode = refusalExitCode(nextClaim.error.code);
            return;
          }
          // Roots first is the operation's two-phase shape (rootsOnly claim,
          // live-children fallback saying so explicitly) — the root is the
          // unit of work, so a todo child parented under non-todo work is
          // never invisible (revised rule — see the --next help text).
          const nextUpdated = nextClaim.data;
          const nextIsChildClaim = (nextClaim.steps ?? []).some(
            (s) => s.code === "CHILD_CLAIM",
          );

          // Blocked candidates the claim above skipped: every filter-matching
          // todo whose `blocks` link points at unfinished work. Computed AFTER
          // the claim, so the just-claimed task (now in-progress) is excluded
          // and the remainder is exactly what `--next` refused to hand out.
          // Only `done` satisfies a link — `review` is NOT done. The snapshot
          // comes from the read ports (same authority the operation read),
          // and the policy itself is the shared selector module.
          const { store: nextDisplayStore } = resolveReadPorts(nextCtx);
          const nextBoard = await nextDisplayStore.listTasks(nextProjectDir);
          const nextBlocked = collectBlockedCandidates(
            nextBoard,
            nextClaimFilter,
          );
          const formatBlockedLine = (b: {
            task: { id: string; title: string };
            blockers: { id: string; title: string; status: string }[];
          }): string =>
            `${b.task.id.slice(0, 8)} ${b.task.title} — blocked by ${b.blockers
              .map((bl) => `${bl.id.slice(0, 8)} ${bl.title} [${bl.status}]`)
              .join(", ")}`;
          // Stranded candidates the claim above refused: filter-matching
          // todo children whose parent chain is not live work (backlog/done
          // parent, or a dangling link). Owner rule (ticket 4ab7104a): these
          // are never claimed by the fallback, and they are named here so
          // the refusal is visible — silence would make them unreachable
          // (root-only listing hides children, --next will not take them).
          // A backlog parent still shows its children locally (`tasks --get
          // <id>` ends with "children (n):"), so the unit stays actionable
          // by hand: move the parent to todo, or claim the child by id.
          const nextStranded = collectStrandedCandidates(
            nextBoard,
            nextClaimFilter,
          );
          const nextBlockedPayload = nextBlocked.map((b) => ({
            id: b.task.id,
            title: b.task.title,
            blockedBy: b.blockers.map((bl) => ({
              id: bl.id,
              title: bl.title,
              status: bl.status,
            })),
          }));

          if (!nextUpdated) {
            const nextHasStranded = nextStranded.length > 0;
            if (nextBlocked.length > 0 || nextHasStranded) {
              // Every remaining candidate is blocked or stranded: claim
              // nothing and say so explicitly — "all work is blocked" and
              // "only stranded children remain" must each read differently
              // from "no work".
              if (opts.json) {
                outputEnvelope({
                  ok: true,
                  json: true,
                  payload: {
                    task: null,
                    next_actions: [],
                    ...(nextBlocked.length > 0
                      ? {
                          blocked: nextBlockedPayload,
                          allBlocked: nextBlocked.length > 0 && !nextHasStranded,
                        }
                      : {}),
                    ...(nextHasStranded ? { stranded: nextStranded } : {}),
                  },
                });
                return;
              }
              if (nextBlocked.length > 0) {
                console.log(
                  chalk.yellow(
                    `All remaining todo tasks are blocked (${nextBlocked.length}) — nothing claimed:`,
                  ),
                );
                for (const b of nextBlocked)
                  console.log(chalk.dim(`    • ${formatBlockedLine(b)}`));
              }
              if (nextHasStranded) {
                console.log(
                  chalk.yellow(
                    `  ⊘ skipped ${nextStranded.length} stranded todo child${nextStranded.length === 1 ? "" : "ren"} (parent not live work, not claimed):`,
                  ),
                );
                for (const s of nextStranded)
                  console.log(
                    chalk.dim(
                      `    • ${s.id.slice(0, 8)} ${s.title} — parent ${s.parentId?.slice(0, 8) ?? "?"} ${s.parentTitle} [${s.parentStatus ?? "missing"}]`,
                    ),
                  );
                console.log(
                  chalk.dim(
                    `    Move the parent to todo, or claim the child by id.`,
                  ),
                );
              }
              return;
            }
            // A filter that matched nothing lands HERE too — same success,
            // same payload, no special case.
            outputNothingToClaim(opts.json);
            if (opts.json) return;
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

          // A dry-run preview names the task but writes nothing: no
          // next actions (there is nothing to act on yet) and no
          // "moved to in-progress" wording below — the previewed record
          // stays todo, which is how a consumer tells nothing was claimed.
          const nextLocalNextActions = nextIsDryRun
            ? []
            : getNextActions("set-status:in-progress", nextUpdated.id);
          // The root is the unit of work: report its children and their
          // statuses alongside it, so the agent can see what remains without a
          // second call. Empty for a childless root. For a child claim the
          // useful context runs the other way — the parent it was taken from.
          // Reuses the port snapshot above (no second store read).
          const nextLocalChildren = summariseChildren(
            nextBoard,
            nextUpdated.id,
          );
          const nextClaimedParent: {
            id: string;
            title: string;
            status?: string;
          } | null = nextIsChildClaim
            ? (() => {
                const pid = getParentId(nextUpdated);
                if (!pid) return null;
                const p = nextBoard.find((t) => t.id === pid);
                return p
                  ? { id: p.id, title: p.title, status: p.status as string }
                  : { id: pid, title: "(not found)" };
              })()
            : null;
          if (opts.json) {
            const nextLocalPayload: Record<string, unknown> = {
              task: nextUpdated,
              next_actions: nextLocalNextActions,
              childClaim: nextIsChildClaim,
            };
            if (nextBlockedPayload.length > 0) {
              nextLocalPayload.blocked = nextBlockedPayload;
            }
            if (nextStranded.length > 0) {
              nextLocalPayload.stranded = nextStranded;
            }
            if (nextLocalChildren.length > 0) {
              nextLocalPayload.children = nextLocalChildren;
            }
            if (nextClaimedParent) {
              nextLocalPayload.parent = nextClaimedParent;
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
          // Display details through the read ports (same authority the
          // operation read — the get-task precedent), reusing the board
          // snapshot above for relations instead of a third store read.
          const structuredComments = (
            await nextDisplayStore.listComments(nextProjectDir, nextUpdated.id)
          ).sort(sortByCreatedAt);
          const linkedFiles = (
            await nextDisplayStore.listFiles(nextProjectDir, nextUpdated.id)
          ).map((f) => ({
            ...f,
            url: `http://localhost:${config.port}${f.url}`,
          }));
          const nextLocalFilePath =
            findTaskFilePath(nextProjectDir, nextUpdated.id) ?? "";
          const agentMessage = renderTaskForAgent(
            nextUpdated,
            nextLocalFilePath,
            structuredComments,
            linkedFiles,
            nextProjectDir,
            nextBoard,
          );

          console.log(
            nextIsDryRun
              ? chalk.green.bold(
                  "▶ WOULD CLAIM (dry-run — nothing was written):",
                )
              : chalk.green.bold(
                  "▶ NEXT TASK — Status moved to in-progress. Implement this now:",
                ),
          );
          console.log();
          if (nextBlocked.length > 0) {
            // Name what the claim skipped, with numbers: invisibility is
            // the bug being fixed, so silence here is not acceptable.
            console.log(
              chalk.yellow(
                `  ⊘ skipped ${nextBlocked.length} blocked task${nextBlocked.length === 1 ? "" : "s"} (still todo, not claimed):`,
              ),
            );
            for (const b of nextBlocked)
              console.log(chalk.dim(`    • ${formatBlockedLine(b)}`));
            console.log();
          }
          if (nextStranded.length > 0) {
            // Name the children the fallback refused: a stranded todo is
            // not claimable until its parent returns to live work — say so
            // with the remedy, so the refusal never reads as invisibility.
            console.log(
              chalk.yellow(
                `  ⊘ skipped ${nextStranded.length} stranded todo child${nextStranded.length === 1 ? "" : "ren"} (parent not live work, not claimed):`,
              ),
            );
            for (const s of nextStranded)
              console.log(
                chalk.dim(
                  `    • ${s.id.slice(0, 8)} ${s.title} — parent ${s.parentId?.slice(0, 8) ?? "?"} ${s.parentTitle} [${s.parentStatus ?? "missing"}]`,
                ),
              );
            console.log(
              chalk.dim(
                `    Move the parent to todo, or claim the child by id.`,
              ),
            );
            console.log();
          }
          if (nextIsChildClaim && nextClaimedParent) {
            // Unambiguous: this run claimed a CHILD, not a root — name the
            // parent and its status so the agent knows which unit it sliced off.
            const claimedParentStatus = nextClaimedParent.status
              ? ` [${nextClaimedParent.status}]`
              : "";
            console.log(
              chalk.yellow(
                `  ⤷ CHILD CLAIM — no todo root was available, so this claims a todo child of ${nextClaimedParent.id.slice(0, 8)}${claimedParentStatus}.`,
              ),
            );
            console.log();
          }
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
          if (!nextIsDryRun) {
            console.log(
              chalk.yellow(
                "  ⚡ This task is already in-progress. Implement it now and mark as review when done.",
              ),
            );
            printNextHint(nextLocalNextActions);
          }
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

          // ── Annotation fields (--url / --selector / --sort-key) ───────
          // Resolved ONCE, here, so the dry-run preview and the real write
          // below cannot drift apart: a preview that omits a field the write
          // sets is a lie. `selector` keeps its historic "/" default when
          // the flag is absent (and falls back to it for a blank value), so
          // an `--add` with no annotation flags writes byte-identical JSON to
          // before. A malformed --url is refused with the same E_USAGE
          // envelope --parent uses for a dangling target, before anything is
          // written.
          const url = opts.url?.trim();
          const selector = opts.selector?.trim() || "/";
          const sortKey = opts.sortKey?.trim();
          if (url && !isParsableUrl(url)) {
            outputEnvelope({ ok: false,
              code: "E_USAGE",
              message: `Invalid --url: "${opts.url}"`,
              suggestion:
                '--url must be a full URL including the scheme (example: vibeflow tasks --add --title "Fix CTA spacing" --url https://example.com/pricing --selector "#cta")',
              json: opts.json,
            });
            process.exitCode = ExitCode.USAGE;
            return;
          }

          const addMode = await getMode();
          if (addMode === "saas") {
            // Online parent links (parity with hosted MCP create_task):
            // the v0 POST body carries `links`, and a parent entry is the
            // online spelling of the local `--parent` flag. The raw value
            // is resolved against the online board BEFORE the POST — a
            // prefix must name the task it means (exact id wins, a unique
            // prefix resolves, anything else is refused here) so a
            // user-supplied prefix is never passed through to the server
            // unresolved. A dangling target is the CLI's own TASK_NOT_FOUND
            // refusal, not the server's INVALID_LINKS. Detail-first: a FULL
            // parent id hits one GET and never enumerates the board; only
            // a 404 falls back to ONE listing for prefix resolution.
            let addLinks: Array<{ taskId: string; type: string }> | undefined;
            const addWorkspace = await readWorkspace();
            if (typeof opts.parent === "string") {
              const addParentProbe = await fetchSaasTaskDetail(opts.parent);
              if (addParentProbe.ok) {
                addLinks = [
                  { taskId: addParentProbe.data.task.id, type: "parent" },
                ];
              } else if (addParentProbe.error.code !== "TASK_NOT_FOUND") {
                const addParentReadMessage = saasReadErrorMessage(
                  addParentProbe.error,
                );
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    ...saasFailure(addParentProbe.error),
                    message: `Unable to resolve parent ${opts.parent} in the online board (${addParentReadMessage}).`,
                    json: opts.json,
                  });
                } else {
                  console.log(
                    chalk.red(
                      `✗ Unable to resolve parent ${opts.parent} in the online board (${addParentReadMessage}).`,
                    ),
                  );
                }
                process.exitCode = ExitCode.GENERAL;
                return;
              } else {
                const addBoard = await fetchSaasTasks(addWorkspace?.id, {
                  hydrate: false,
                });
                if (!addBoard.ok) {
                  const addParentReadMessage = saasReadErrorMessage(
                    addBoard.error,
                  );
                  if (opts.json) {
                    outputEnvelope({
                      ok: false,
                      ...saasFailure(addBoard.error),
                      message: `Unable to resolve parent ${opts.parent} in the online board (${addParentReadMessage}).`,
                      json: opts.json,
                    });
                  } else {
                    console.log(
                      chalk.red(
                        `✗ Unable to resolve parent ${opts.parent} in the online board (${addParentReadMessage}).`,
                      ),
                    );
                  }
                  process.exitCode = ExitCode.GENERAL;
                  return;
                }
                const addResolved = resolveSaasTaskId(
                  addBoard.data.tasks,
                  opts.parent,
                );
                if (!addResolved.ok) {
                  if (addResolved.code === "TASK_NOT_FOUND") {
                    const addParentMessage = `Parent task not found: ${opts.parent}`;
                    if (opts.json) {
                      outputEnvelope({
                        ok: false,
                        code: "TASK_NOT_FOUND",
                        message: addParentMessage,
                        suggestion:
                          "Run 'vibeflow tasks' to see available task IDs.",
                        json: opts.json,
                      });
                    } else {
                      console.log(chalk.red(`✗ ${addParentMessage}`));
                      console.log(
                        chalk.dim(
                          "  Run 'vibeflow tasks' to see available task IDs.",
                        ),
                      );
                    }
                    process.exitCode = ExitCode.NOT_FOUND;
                  } else {
                    if (opts.json) {
                      outputEnvelope({
                        ok: false,
                        code: addResolved.code,
                        message: addResolved.message,
                        suggestion:
                          "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                        json: opts.json,
                      });
                    } else {
                      console.log(chalk.red(`✗ ${addResolved.message}`));
                      console.log(
                        chalk.dim(
                          "  Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                        ),
                      );
                    }
                    process.exitCode = ExitCode.USAGE;
                  }
                  return;
                }
                addLinks = [{ taskId: addResolved.id, type: "parent" }];
              }
            }
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
                ...(addLinks ? { links: addLinks } : {}),
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
                if (addLinks)
                  console.log(
                    chalk.dim(`    parent: ${addLinks[0].taskId}`),
                  );
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
              ...(addLinks ? { links: addLinks } : {}),
            });
            if (!saasCreated.ok) {
              // A structured backend refusal (e.g. INVALID_LINKS for a
              // dangling parent) is the server's answer, not an outage —
              // surface its code verbatim so CLI-online and hosted MCP
              // refuse identically instead of hiding behind
              // E_BACKEND_UNAVAILABLE ("retry" would never fix it).
              const createServerCode = saasCreated.error.serverCode;
              // Ticket 5094958f: the generic branch used to discard the
              // HTTP status (and any non-JSON body head) — a proxy 502 HTML
              // page or an empty body surfaced as a bare "Failed to create"
              // with nothing to diagnose. Name status + path + head here;
              // a true transport failure (no status) keeps the old message
              // and the connection hint verbatim.
              const createErr = saasCreated.error;
              const createWhere =
                typeof createErr.status === "number"
                  ? `HTTP ${createErr.status}${createErr.path ? ` ${createErr.path}` : ""}`
                  : null;
              const createHead =
                typeof createErr.bodyHead === "string" &&
                createErr.bodyHead.length > 0
                  ? ` — response head: ${createErr.bodyHead}`
                  : "";
              const createGenericMessage =
                createWhere !== null
                  ? `Failed to create task in online board (${createWhere}${createHead}).`
                  : "Failed to create task in online board.";
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  ...(createServerCode
                    ? {
                        code: createServerCode,
                        message: saasCreated.error.message,
                      }
                    : {
                        ...saasFailure(saasCreated.error),
                        message: createGenericMessage,
                      }),
                  json: opts.json,
                });
              } else if (createServerCode) {
                console.log(chalk.red(`✗ ${saasCreated.error.message}`));
              } else {
                console.log(chalk.red(`✗ ${createGenericMessage}`));
                if (createWhere === null) {
                  console.log(
                    chalk.yellow(
                      "  Check your connection or run 'vibeflow login'.",
                    ),
                  );
                }
              }
              process.exitCode = ExitCode.GENERAL;
              return;
            }
            const saasCreatedTask = saasCreated.data;
            // Clone mode (ticket 4efaa878): the task the server ACCEPTED is
            // also persisted in the local `.vibeflow` store as its normal
            // `.json` record, so the local copy exists for
            // grep/diff/inspection offline and the two stay identical.
            // Written from the response (the accepted record), never
            // re-derived from the request — see saas/clone.ts. A failed
            // create returned above, so a failure can never leave a clone
            // behind; a failed clone write warns loudly and keeps the
            // landed create (exit 0 is the truth about the server write).
            try {
              writeOnlineClone(resolve(dir), saasCreatedTask);
            } catch (err) {
              const cloneMessage = `Online task created, but the local clone could not be written (${err instanceof Error ? err.message : String(err)}). Run 'vibeflow pull' to fetch it.`;
              if (opts.json) {
                console.error(cloneMessage);
              } else {
                console.log(chalk.yellow(`  ⚠ ${cloneMessage}`));
              }
            }
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
          // ONE id rule (`resolveSaasTaskId`, shared with --get/--edit/--delete
          // and the online --parent path): exact id wins, a UNIQUE prefix
          // resolves, an ambiguous prefix is E_AMBIGUOUS naming the
          // candidates — never a silent first-match. A brand-new task has
          // no id yet, so self-link, duplicate and cycle are structurally
          // impossible (see report).
          let parentId: string | undefined;
          if (typeof opts.parent === "string") {
            const rawParent = opts.parent;
            const parentResolved = resolveSaasTaskId(
              listTasks(projectDir).map((t) => ({ id: t.id, title: t.title })),
              rawParent,
            );
            if (!parentResolved.ok) {
              if (parentResolved.code === "E_AMBIGUOUS") {
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    code: parentResolved.code,
                    message: parentResolved.message,
                    suggestion:
                      "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                    json: opts.json,
                  });
                } else {
                  console.log(chalk.red(`✗ ${parentResolved.message}`));
                  console.log(
                    chalk.dim(
                      "  Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                    ),
                  );
                }
                process.exitCode = ExitCode.USAGE;
              } else {
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    code: "TASK_NOT_FOUND",
                    message: `Parent task not found: ${rawParent}`,
                    suggestion: "Run 'vibeflow tasks' to see available task IDs.",
                    json: opts.json,
                  });
                } else {
                  console.log(chalk.red(`✗ Parent task not found: ${rawParent}`));
                  console.log(
                    chalk.dim("  Run 'vibeflow tasks' to see available task IDs."),
                  );
                }
                process.exitCode = ExitCode.NOT_FOUND;
              }
              return;
            }
            parentId = parentResolved.id;
          }

          if (opts.dryRun) {
            const dryId = generateTaskId();
            const dryTask = {
              id: dryId,
              title: opts.title.trim(),
              description: opts.description?.trim() ?? "",
              status,
              ...(url ? { url } : {}),
              selector,
              ...(sortKey ? { sortKey } : {}),
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
              // Only shown when the flags were passed, so the pre-existing
              // preview output is unchanged for an unannotated --add.
              if (dryTask.url)
                console.log(chalk.dim(`    url:      ${dryTask.url}`));
              if (selector !== "/")
                console.log(chalk.dim(`    selector: ${selector}`));
              if (dryTask.sortKey)
                console.log(chalk.dim(`    sortKey:  ${dryTask.sortKey}`));
              printNextHint(getNextActions("add", dryId));
            }
            return;
          }

          const created = createTask(projectDir, {
            title: opts.title.trim(),
            description: opts.description?.trim() ?? "",
            status,
            // Annotation fields mirror the dry-run preview above field for
            // field: url only when --url was given, selector always (the
            // historic "/" default), sortKey only when --sort-key was given
            // (core mints its own otherwise).
            ...(url ? { url } : {}),
            selector,
            ...(sortKey ? { sortKey } : {}),
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
            // --fields narrows the returned task (same selector the MCP
            // create_task `fields` takes; parity contract 83159002).
            const addFields = opts.fields
              ? opts.fields
                  .split(",")
                  .map((f: string) => f.trim())
                  .filter(Boolean)
              : [];
            // SAFETY: Task objects are plain JSON-serializable; Record<string, unknown> is the superset for field picking.
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                task: pickFields(
                  created as unknown as Record<string, unknown>,
                  addFields,
                ),
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
        // `tasks --commit --task <id> [--message "<msg>"] [-- <paths...>]`
        // records a pathspec-scoped commit and links it to the task. Flag
        // parsing and the gate above stay here; every effect — id
        // resolution, the scoped commit, the record link, the best-effort
        // auto-push — runs in the shared `commitTaskPathsOperation`
        // (core/operations/git.ts), so an explicit commit can never sweep
        // another lane's staged work into this task's commit. The renderer
        // below performs no store or git reads of its own.
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
          const commitOpCtx: OperationContext = {
            projectDir: resolve(dir),
            mode: "local",
          };
          const commitResult = await operations.commitTaskPathsOperation(commitOpCtx, {
            id: opts.task,
            ...(opts.message !== undefined ? { message: opts.message } : {}),
            ...(commitPathspec.length > 0 ? { paths: commitPathspec } : {}),
            ...(opts.dryRun ? { dryRun: true } : {}),
            ...(opts.json ? { capturePushOutput: true } : {}),
          });
          if (!commitResult.ok) {
            const commitErr = commitResult.error;
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: commitErr.code,
                message: commitErr.message,
                ...(commitErr.suggestion
                  ? { suggestion: commitErr.suggestion }
                  : {}),
                json: opts.json,
              });
            } else if (commitErr.code === "GIT_COMMIT_FAILED") {
              console.log(chalk.red(`✗ ${commitErr.message}`));
              // Throw-path detail only: the notice path carries a
              // suggestion but prints no `reason:` line, exactly as before.
              if (commitErr.reason) {
                console.log(chalk.dim(`  reason: ${commitErr.reason}`));
              }
            } else {
              outputEnvelope({
                ok: false,
                code: commitErr.code,
                message: commitErr.message,
                ...(commitErr.suggestion
                  ? { suggestion: commitErr.suggestion }
                  : {}),
                json: opts.json,
              });
            }
            process.exitCode =
              commitErr.code === "TASK_NOT_FOUND" ||
              commitErr.code === "E_NOT_FOUND"
                ? ExitCode.NOT_FOUND
                : commitErr.code === "E_AMBIGUOUS" ||
                    commitErr.code === "E_USAGE"
                  ? ExitCode.USAGE
                  : ExitCode.GENERAL;
            return;
          }
          const committed = commitResult.data;
          const commitNextActions = getNextActions("commit", committed.taskId);
          if (committed.dryRun) {
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  dryRun: true,
                  action: "commit",
                  message: committed.message,
                  taskId: committed.taskId,
                  next_actions: commitNextActions,
                },
              });
            } else {
              console.log(chalk.yellow("  [dry-run] Would commit:"));
              console.log(chalk.dim(`    message: ${committed.message}`));
              console.log(chalk.dim(`    task:    ${committed.taskId}`));
              printNextHint(commitNextActions);
            }
            return;
          }
          // Warn when committing for a Research task — code changes should not be made.
          // (Under --json stdout carries only the envelope — this warning is
          // human-mode only.)
          if (!opts.json && (committed.taskType ?? "").toLowerCase() === "research") {
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
          const autoPush = committed.autoPush;
          if (opts.json) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                commit: committed.sha,
                linkedExisting: committed.linkedExisting,
                committed: committed.committed,
                leftStaged: committed.foreign,
                // The push ran; this says how it went. `attempted: false`
                // covers a linked existing commit (nothing new to push) and a
                // store with autoPush off.
                autoPush,
                next_actions: commitNextActions,
              },
            });
          } else if (committed.linkedExisting) {
            // Nothing to commit is NOT a dead end: the caller's intent is to
            // record that this task's work is in commit X, and when the work
            // is already committed, X is HEAD.
            const reason =
              commitPathspec.length > 0
                ? `no changes to commit for: ${commitPathspec.join(", ")}`
                : "the task's own record has no staged changes";
            console.log(chalk.yellow(`ℹ  Nothing to commit — ${reason}.`));
            console.log(
              chalk.green(`✓ Linked existing commit to task: ${committed.taskTitle}`),
            );
            console.log(chalk.dim(`  commit: ${committed.sha} (HEAD)`));
            console.log(chalk.dim(`  vibeflow:  ${committed.taskId}`));
            printNextHint(commitNextActions);
          } else {
            console.log(
              chalk.green(`✓ Committed and linked to task: ${committed.taskTitle}`),
            );
            console.log(chalk.dim(`  commit: ${committed.sha}`));
            console.log(chalk.dim(`  vibeflow:  ${committed.taskId}`));
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
          return;
        }

        // ── Attach mode ────────────────────────────────────────────────────
        // `tasks --attach <path> --task <id>`: upload one file to a task's
        // file list without touching any of its fields (any task type, no
        // status change — unlike Research-only --report-file, which is tied
        // to the review transition). Flag parsing and the gates above stay
        // here; every effect — id resolution, source gates, the duplicate
        // policy, the upload, the --move consumption — runs in the shared
        // `attachStandalone` operation (core/operations/files.ts), so the
        // CLI and MCP `attach_file` cannot disagree on what a pair means.
        // The policy split is explicit in the call: the CLI refuses a
        // repeated (task, name) pair (E_FILE_EXISTS), MCP replaces in place.
        if (opts.attach !== undefined) {
          const attachRawTask = opts.task!.trim();
          const attachMode = await getMode();
          const attachOpCtx: OperationContext = {
            projectDir: resolve(dir),
            mode: attachMode === "saas" ? "saas" : "local",
          };
          const attachResult = await operations.attachStandalone(attachOpCtx, {
            id: attachRawTask,
            // The source resolves against the invocation cwd (like
            // --report-file); the [dir] positional is the project root.
            source: {
              kind: "localPath",
              path: opts.attach,
              cwd: process.cwd(),
            },
            onExisting: "refuse",
            ...(opts.move ? { moveAfterSuccess: true } : {}),
            ...(opts.dryRun ? { dryRun: true } : {}),
          });
          if (!attachResult.ok) {
            const attachErr = attachResult.error;
            outputEnvelope({
              ok: false,
              code: attachErr.code,
              message: attachErr.message,
              suggestion: attachErr.suggestion,
              json: opts.json,
            });
            // Caller errors (bad id, bad path, duplicate) are USAGE; a
            // missing task or source is NOT_FOUND; anything else (dead
            // backend, rejected token, failed upload) is GENERAL. A code
            // the operation invents tomorrow fails closed to GENERAL —
            // never silently to USAGE.
            process.exitCode =
              attachErr.code === "TASK_NOT_FOUND" ||
              attachErr.code === "E_NOT_FOUND"
                ? ExitCode.NOT_FOUND
                : attachErr.code === "E_AMBIGUOUS" ||
                    attachErr.code === "E_USAGE" ||
                    attachErr.code === "E_FILE_EXISTS" ||
                    attachErr.code === "E_FILE_TOO_LARGE" ||
                    attachErr.code === "INVALID_FILENAME" ||
                    attachErr.code === "UNSUPPORTED_FILE_TYPE"
                  ? ExitCode.USAGE
                  : ExitCode.GENERAL;
            return;
          }
          const attached = attachResult.data!;
          const attachNotices: PartialSuccessNotice[] = attachResult.steps ?? [];
          if (opts.dryRun) {
            if (opts.json) {
              outputEnvelope({
                ok: true,
                json: opts.json,
                payload: {
                  dryRun: true,
                  action: "attach",
                  taskId: attached.taskId,
                  name: attached.name,
                  size: attached.size,
                  ...(opts.move ? { move: "(source file kept)" } : {}),
                },
              });
            } else {
              console.log(chalk.yellow("  [dry-run] Would attach:"));
              console.log(chalk.dim(`    file: ${attached.name}`));
              console.log(chalk.dim(`    size: ${attached.size}`));
              console.log(chalk.dim(`    task: ${attached.taskId}`));
              if (opts.move)
                console.log(chalk.dim("    move: (source file kept)"));
            }
            return;
          }
          if (!opts.json) {
            for (const notice of attachNotices) {
              console.log(chalk.yellow(`⚠ ${notice.message}`));
            }
          }
          if (opts.json) {
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                taskId: attached.taskId,
                fileId: attached.fileId ?? attached.name,
                name: attached.name,
                size: attached.size,
                ...noticeFields(attachNotices),
              },
            });
          } else {
            console.log(
              chalk.green(
                `✓ Attached ${attached.name} (${attached.size} bytes) to task ${attached.taskId}`,
              ),
            );
            console.log(
              chalk.dim(`  file id: ${attached.fileId ?? attached.name}`),
            );
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
            opts.relates?.length ||
            opts.blocks?.length ||
            opts.unrelates?.length ||
            opts.unblocks?.length ||
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

          // ── Fail fast: --commit-message on review (before ANY work) ──
          // The review gate also enforces this, but the gate runs after a
          // long chain of validation output — so a run missing only the
          // commit message looked like it did work before refusing. Check
          // it here, first, so the refusal is the only output. (Also
          // stated on the --commit-message flag itself.)
          if (opts.setStatus === "review") {
            const failFastSettings = loadSettings(resolve(dir));
            if (
              failFastSettings.autoCommit &&
              !opts.commitMessage?.trim()
            ) {
              const failFastMessage =
                "--commit-message is required (auto-commit setting is ON)";
              const failFastSuggestion =
                'Stage your changes first, then give a one-line commit summary — vibeflow tasks --edit <id> --set-status review --commit-message "fix: description" --comment "what changed and why"';
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "COMMIT_MESSAGE_REQUIRED",
                  message: failFastMessage,
                  suggestion: failFastSuggestion,
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ ${failFastMessage}`));
                console.log(chalk.dim(`  ${failFastSuggestion}`));
              }
              process.exitCode = ExitCode.USAGE;
              return;
            }
          }

          // ── Resolve the --edit target ONCE, through the ONE resolver ──
          // Every id-taking flag routes through `resolveSaasTaskId` (exact
          // id wins, else a UNIQUE prefix; an ambiguous prefix is
          // E_AMBIGUOUS naming the candidates; only then TASK_NOT_FOUND;
          // an empty id is refused, never a prefix of everything). The
          // resolved FULL id feeds every step below (probes, gate, write,
          // auto-commit), so a prefix can never resolve one way for the
          // gate and another for the write. In online mode a FULL id hits
          // ONE detail request and never enumerates the board (no listing
          // pages, no 500-page cap failure for a valid id, no
          // tasks:read-of-everything for a straight PATCH); only a 404
          // falls back to ONE unhydrated listing for prefix resolution
          // through the ONE resolver — resolver semantics are identical.
          // The same listing is reused for link-target resolution below
          // instead of being fetched twice.
          const editMode = await getMode();
          let editTargetId: string;
          let editLinkBoard: SaasTask[] | undefined;
          if (editMode === "saas") {
            const editWorkspace = await readWorkspace();
            const editDetail = await fetchSaasTaskDetail(taskId);
            if (editDetail.ok) {
              editTargetId = editDetail.data.task.id;
            } else if (editDetail.error.code !== "TASK_NOT_FOUND") {
              const editReadMessage = saasReadErrorMessage(editDetail.error);
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  ...saasFailure(editDetail.error),
                  message: `Unable to resolve task ${taskId} in the online board (${editReadMessage}).`,
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red(
                    `✗ Unable to resolve task ${taskId} in the online board (${editReadMessage}).`,
                  ),
                );
              }
              process.exitCode = ExitCode.GENERAL;
              return;
            } else {
              const editBoard = await fetchSaasTasks(editWorkspace?.id, {
                hydrate: false,
              });
              if (!editBoard.ok) {
                const editReadMessage = saasReadErrorMessage(editBoard.error);
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    ...saasFailure(editBoard.error),
                    message: `Unable to resolve task ${taskId} in the online board (${editReadMessage}).`,
                    json: opts.json,
                  });
                } else {
                  console.log(
                    chalk.red(
                      `✗ Unable to resolve task ${taskId} in the online board (${editReadMessage}).`,
                    ),
                  );
                }
                process.exitCode = ExitCode.GENERAL;
                return;
              }
              const editResolved = resolveSaasTaskId(
                editBoard.data.tasks,
                taskId,
              );
              if (!editResolved.ok) {
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    code: editResolved.code,
                    message:
                      editResolved.code === "TASK_NOT_FOUND"
                        ? `Task not found: ${taskId}`
                        : editResolved.message,
                    suggestion:
                      editResolved.code === "TASK_NOT_FOUND"
                        ? "Run 'vibeflow tasks' to see available task IDs."
                        : "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                    json: opts.json,
                  });
                } else {
                  console.log(
                    chalk.red(
                      `✗ ${editResolved.code === "TASK_NOT_FOUND" ? `Task not found: ${taskId}` : editResolved.message}`,
                    ),
                  );
                  console.log(
                    chalk.dim(
                      editResolved.code === "TASK_NOT_FOUND"
                        ? "  Run 'vibeflow tasks' to see available task IDs."
                        : "  Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                    ),
                  );
                }
                process.exitCode =
                  editResolved.code === "TASK_NOT_FOUND"
                    ? ExitCode.NOT_FOUND
                    : ExitCode.USAGE;
                return;
              }
              editTargetId = editResolved.id;
              editLinkBoard = editBoard.data.tasks;
            }
            // Link flags resolve against ONE board listing, fetched here
            // only when the detail hit left us without one (a full-id
            // target plus link flags). A prefix-resolved target already
            // holds the listing above — this never adds a second one.
            if (
              editLinkBoard === undefined &&
              (wantsParentChange ||
                (opts.relates?.length ?? 0) > 0 ||
                (opts.blocks?.length ?? 0) > 0 ||
                (opts.unrelates?.length ?? 0) > 0 ||
                (opts.unblocks?.length ?? 0) > 0)
            ) {
              const editLinkFetch = await fetchSaasTasks(editWorkspace?.id, {
                hydrate: false,
              });
              if (!editLinkFetch.ok) {
                const editLinkMessage = saasReadErrorMessage(
                  editLinkFetch.error,
                );
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    ...saasFailure(editLinkFetch.error),
                    message: `Unable to resolve link targets for task ${editTargetId} in the online board (${editLinkMessage}).`,
                    json: opts.json,
                  });
                } else {
                  console.log(
                    chalk.red(
                      `✗ Unable to resolve link targets for task ${editTargetId} in the online board (${editLinkMessage}).`,
                    ),
                  );
                }
                process.exitCode = ExitCode.GENERAL;
                return;
              }
              editLinkBoard = editLinkFetch.data.tasks;
            }
          } else {
            const editLocalResolved = resolveSaasTaskId(
              listTasks(resolve(dir)).map((t) => ({
                id: t.id,
                title: t.title,
              })),
              taskId,
            );
            if (!editLocalResolved.ok) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: editLocalResolved.code,
                  message:
                    editLocalResolved.code === "TASK_NOT_FOUND"
                      ? `Task not found: ${taskId}`
                      : editLocalResolved.message,
                  suggestion:
                    editLocalResolved.code === "TASK_NOT_FOUND"
                      ? "Run 'vibeflow tasks' to see available task IDs."
                      : "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                  json: opts.json,
                });
              } else {
                console.log(
                  chalk.red(
                    `✗ ${editLocalResolved.code === "TASK_NOT_FOUND" ? `Task not found: ${taskId}` : editLocalResolved.message}`,
                  ),
                );
                console.log(
                  chalk.dim(
                    editLocalResolved.code === "TASK_NOT_FOUND"
                      ? "  Run 'vibeflow tasks' to see available task IDs."
                      : "  Use the full task id — run 'vibeflow tasks' to see available task IDs.",
                  ),
                );
              }
              process.exitCode =
                editLocalResolved.code === "TASK_NOT_FOUND"
                  ? ExitCode.NOT_FOUND
                  : ExitCode.USAGE;
              return;
            }
            editTargetId = editLocalResolved.id;
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
            // The target was already resolved to its full id above (ONE
            // resolver, either store), so the probe is an exact lookup —
            // never a second, possibly divergent prefix guess.
            const reportTask = listTasks(resolve(dir)).find(
              (t) => t.id === editTargetId,
            );
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
                // The attestation contract carries its own recovery text (it is
                // the only place that knows the valid flag combination); before
                // the field existed the CLI had nowhere to put it and printed a
                // bare refusal.
                suggestion: attestation.suggestion,
                json: opts.json,
              });
            } else {
              console.log(chalk.red(`✗ ${attestation.message}`));
              // The recovery text is part of the attestation contract, so the
              // human path prints it like every other refusal does (the gate
              // branch below already did). Without this line `--json` callers
              // got the suggestion and a human agent did not.
              console.log(chalk.dim(`  ${attestation.suggestion}`));
            }
            process.exitCode = ExitCode.USAGE;
            return;
          }

          // ── Research tasks cannot carry a verification verdict ─────────────
          // Standalone --set-verify on a Research task must be rejected the same
          // way the review gate does (RESEARCH_VERIFY_NOT_ALLOWED). This covers
          // both the real write and the --dry-run preview path.
          if (attestation.verdict) {
            // Exact lookup on the already-resolved id (see the --report-file
            // probe above) — never a second prefix guess.
            const probeTask = listTasks(resolve(dir)).find(
              (t) => t.id === editTargetId,
            );
            if (probeTask && isResearchType(probeTask.type)) {
              // The code mirrors what the review gate returns for the same rule,
              // so --json consumers see one code whichever path refuses first —
              // and the WORDING comes from the gate's one definition rather
              // than from a third copy of the sentence (this branch used to
              // carry two).
              const { RESEARCH_VERIFY_NOT_ALLOWED_REFUSAL: refusal } =
                await import("./core/review-gate.js");
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: refusal.code,
                  message: refusal.message,
                  suggestion: refusal.suggestion,
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ ${refusal.message}`));
                console.log(chalk.dim(`  ${refusal.suggestion}`));
              }
              process.exitCode = ExitCode.USAGE;
              return;
            }
          }

          // ── Settings-based enforcement on review ─────────────────────────
          // (editMode was resolved once, above, next to the target id.)
          const projectDir = resolve(dir);
          const settings = loadSettings(projectDir);
          // ── Research report validation (read-only — runs BEFORE the gate)
          // Existence / extension refuse here with E_NOT_FOUND / E_USAGE
          // before the review gate is consulted — but NOTHING is written:
          // the save + source-file delete wait until the gate passes below,
          // so a run that cannot succeed leaves nothing behind.
          let reportPath: string | undefined;
          let dryRunReportName: string | undefined;
          if (opts.setStatus === "review" && opts.reportFile) {
            reportPath = resolve(opts.reportFile);
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
          }
          // ── Unified review gate (shared with MCP update_task) ──────────────
          if (opts.setStatus === "review") {
            const { checkReviewTransition } = await import(
              "./core/review-gate.js"
            );
            // The gate reads the task file by id, so it takes the FULL id
            // resolved once above — a prefix reaching it unresolved would
            // bypass the verdict check entirely.
            const gate = checkReviewTransition(
              projectDir,
              editTargetId,
              {
                comment: opts.comment,
                commitMessage: opts.commitMessage,
                branch: opts.branch,
                // A --report-file carried on THIS transition satisfies gate 5
                // (the path was validated above; the upload lands right after
                // the gate passes). MCP never sends this — it attaches first.
                reportFile: opts.reportFile,
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
          // ── Research report upload (mutation — runs AFTER the gate) ──
          // The gate above is the run's validation, and the path was already
          // proven (existing, .md) in the validation block before it — so
          // reaching here means the run WILL succeed. --dry-run stays a TRUE
          // dry run: the file is never saved or deleted, and the preview
          // rides the dry-run branch below.
          // The source file is still CONSUMED (moved, not copied) on a real
          // run: the task store owns the report from then on, and a copy
          // would leave two divergent copies with no owner. A report meant
          // to keep living in docs/ should be copied by the caller first.
          if (reportPath !== undefined) {
            if (opts.dryRun) {
              dryRunReportName = basename(reportPath);
            } else {
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
          }

          // ── SaaS edit path (online mode) ────────────────────────────────
          // Online links (parity with hosted MCP update_task): the v0 PATCH
          // `links` replaces the whole set, so every link-flag change
          // (--set-parent/--no-parent/--relates/--blocks/--unrelates/
          // --unblocks) is computed here from the task just read and sent
          // as one `links` array. The edited target was already resolved to
          // its full id above, and every id-taking link flag is resolved
          // against the online board BEFORE the PATCH — exact id wins, a
          // unique prefix resolves, anything else is refused here — so a
          // user-supplied prefix is never passed through unresolved. A
          // dangling target is the CLI's own TASK_NOT_FOUND refusal (the
          // same code the local path answers), not the server's
          // INVALID_LINKS; cycle validation still lives server-side and
          // its INVALID_LINKS code is surfaced verbatim below.
          const wantsLinkChange =
            wantsParentChange ||
            (opts.relates?.length ?? 0) > 0 ||
            (opts.blocks?.length ?? 0) > 0 ||
            (opts.unrelates?.length ?? 0) > 0 ||
            (opts.unblocks?.length ?? 0) > 0;
          let saasLinks: Array<{ taskId: string; type: string }> | undefined;
          if (wantsLinkChange && editMode === "saas") {
            // One detail request for the edited task's current links —
            // never a (hydrated) whole-board fetch. The failure names its
            // status/path; a 404 is the existing TASK_NOT_FOUND below.
            // The id is the FULL id resolved once above, never the raw
            // user input.
            const boardTasks = await fetchSaasTaskDetail(editTargetId);
            if (!boardTasks.ok) {
              if (boardTasks.error.code !== "TASK_NOT_FOUND") {
                const parentReadMessage = saasReadErrorMessage(
                  boardTasks.error,
                );
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    ...saasFailure(boardTasks.error),
                    message: `Unable to read task ${editTargetId} from the online board — the link change needs its current links (${parentReadMessage}).`,
                    json: opts.json,
                  });
                } else {
                  console.log(
                    chalk.red(
                      `✗ Unable to read task ${editTargetId} from the online board — the link change needs its current links (${parentReadMessage}).`,
                    ),
                  );
                }
                process.exitCode = ExitCode.GENERAL;
                return;
              }
            }
            const current = boardTasks.ok
              ? boardTasks.data.task
              : undefined;
            if (!current) {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code: "TASK_NOT_FOUND",
                  message: `Task not found: ${editTargetId}`,
                  suggestion:
                    "Run 'vibeflow tasks' to see available task IDs.",
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ Task not found: ${editTargetId}`));
              }
              process.exitCode = ExitCode.NOT_FOUND;
              return;
            }
            // Resolve every id-taking link flag (--set-parent/--relates/
            // --blocks/--unrelates/--unblocks) against the same source
            // the PATCH writes to. Refusals mirror the local path's
            // wording and codes (TASK_NOT_FOUND naming the value,
            // E_AMBIGUOUS naming the candidates, E_USAGE for a self-link).
            // Link targets resolve against the board listing fetched once
            // for the --edit target above — no second listing read, so the
            // target and its links resolve against the same board state.
            const linkBoard: SaasTask[] | undefined = editLinkBoard;
            const refuseLinkTarget = (
              code: string,
              message: string,
              suggestion: string | undefined,
            ): null => {
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  code,
                  message,
                  suggestion,
                  json: opts.json,
                });
              } else {
                console.log(chalk.red(`✗ ${message}`));
                if (suggestion) console.log(chalk.dim(`  ${suggestion}`));
              }
              process.exitCode =
                code === "TASK_NOT_FOUND"
                  ? ExitCode.NOT_FOUND
                  : ExitCode.USAGE;
              return null;
            };
            const resolveLinkTarget = (
              raw: string,
              flag: string,
            ): string | null => {
              const resolved = resolveSaasTaskId(linkBoard ?? [], raw);
              if (resolved.ok) return resolved.id;
              if (resolved.code === "TASK_NOT_FOUND") {
                const message =
                  flag === "--set-parent"
                    ? `Parent task not found: ${raw}`
                    : `Task ${raw} not found`;
                return refuseLinkTarget(
                  resolved.code,
                  message,
                  "Run 'vibeflow tasks' to see available task IDs.",
                );
              }
              return refuseLinkTarget(
                resolved.code,
                `${resolved.message} (${flag} ${raw})`,
                "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
              );
            };
            // Merge order mirrors the local path: the parent swap first
            // (old parent out, new parent appended — never stacked), then
            // additive relates/blocks (dedupe on taskId+type, self refused),
            // then subtractive unrelates/unblocks (absent pairs are no-ops).
            // The v0 PATCH replaces the whole set, so this merged array IS
            // the new link set — nothing the caller did not name is dropped.
            let merged = wantsParentChange
              ? (current.links ?? []).filter((l) => l.type !== "parent")
              : [...(current.links ?? [])];
            if (
              wantsParentChange &&
              !(opts.parent === false || opts.setParent === "")
            ) {
              const parentId = resolveLinkTarget(
                opts.setParent ?? "",
                "--set-parent",
              );
              if (parentId === null) return;
              // Self-link is compared against the FULL resolved id: a
              // prefix of the edited task must not slip past this check.
              if (parentId === editTargetId) {
                refuseLinkTarget(
                  "E_USAGE",
                  "Cannot link a task to itself",
                  undefined,
                );
                return;
              }
              merged = [...merged, { taskId: parentId, type: "parent" }];
            }
            for (const { raw, flag, type } of [
              ...(opts.relates ?? []).map((raw) => ({
                raw,
                flag: "--relates",
                type: "relates",
              })),
              ...(opts.blocks ?? []).map((raw) => ({
                raw,
                flag: "--blocks",
                type: "blocks",
              })),
            ]) {
              const targetId = resolveLinkTarget(raw, flag);
              if (targetId === null) return;
              if (targetId === editTargetId) {
                refuseLinkTarget(
                  "E_USAGE",
                  "Cannot link a task to itself",
                  undefined,
                );
                return;
              }
              if (
                !merged.some(
                  (l) => l.taskId === targetId && l.type === type,
                )
              )
                merged.push({ taskId: targetId, type });
            }
            for (const { raw, flag, type } of [
              ...(opts.unrelates ?? []).map((raw) => ({
                raw,
                flag: "--unrelates",
                type: "relates",
              })),
              ...(opts.unblocks ?? []).map((raw) => ({
                raw,
                flag: "--unblocks",
                type: "blocks",
              })),
            ]) {
              const targetId = resolveLinkTarget(raw, flag);
              if (targetId === null) return;
              merged = merged.filter(
                (l) => !(l.taskId === targetId && l.type === type),
              );
            }
            saasLinks = merged;
          }
          if (editMode === "saas") {
            const saasPatch: {
              status?: string;
              title?: string;
              description?: string;
              branchName?: string;
              verified?: boolean | null;
              links?: Array<{ taskId: string; type: string }>;
            } = {};
            if (opts.setStatus) saasPatch.status = opts.setStatus;
            if (opts.title) saasPatch.title = opts.title;
            if (opts.description) saasPatch.description = opts.description;
            if (opts.branch) saasPatch.branchName = opts.branch;
            if (saasLinks !== undefined) saasPatch.links = saasLinks;

            // ── Agent attestation (--set-verify) ─────────────────────
            // Same tri-state mapping the local path uses (see
            // core/verify-attestation.ts and the local `updates.verified`
            // block below): pass → true, fail → false, cannot → cleared.
            // The SaaS column is a tri-state boolean too (`verified` accepts
            // null), so `undefined` means "no change" and `null` clears to
            // absent — matching how updateSaasTask sends null explicitly to
            // clear. Claiming (in-progress) with no verdict clears it as
            // well, mirroring the local reset-on-claim. This branch
            // previously never read opts.setVerify, so a verdict was
            // silently dropped while the command reported success.
            if (attestation.value !== undefined)
              saasPatch.verified = attestation.value;
            else if (
              attestation.verdict === "cannot" ||
              attestation.clear
            )
              saasPatch.verified = null;
            else if (opts.setStatus === "in-progress")
              saasPatch.verified = null;

            // Conflict detection: warn when attempting in-progress on an already in-progress task
            // (the FULL resolved id — a prefix never reaches the server).
            if (opts.setStatus === "in-progress") {
              const current = await fetchSaasTask(editTargetId);
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

            // ── Dry run: preview only, never touch the backend ──────
            // updateSaasTask PATCHes shared remote state (and addSaasComment
            // POSTs to it below), so --dry-run returns before either is
            // called. The fetchSaasTask conflict check above stays: it is a
            // read-only GET. The preview mirrors the local path's shape
            // (JSON payload { dryRun: true, ... }; human "[dry-run]" lines).
            if (opts.dryRun) {
              const dryUpdates: Record<string, unknown> = {};
              if (saasPatch.status !== undefined)
                dryUpdates.status = saasPatch.status;
              if (saasPatch.title !== undefined)
                dryUpdates.title = saasPatch.title;
              if (saasPatch.description !== undefined)
                dryUpdates.description = saasPatch.description;
              if (saasPatch.branchName !== undefined)
                dryUpdates.branchName = saasPatch.branchName;
              if (saasPatch.verified !== undefined)
                dryUpdates.verified = saasPatch.verified;
              if (saasPatch.links !== undefined)
                dryUpdates.links = saasLinks;
              // A `cannot` verdict also posts the reason as a comment (see
              // the write path below), so the preview names that second
              // write instead of letting --dry-run hide it.
              if (attestation.verdict === "cannot" && attestation.reason)
                dryUpdates.verifyReason =
                  `${attestation.reason} (would record as comment)`;
              if (dryRunReportName)
                dryUpdates.report = `${dryRunReportName} (would attach; source file kept)`;
              if (opts.comment?.trim()) dryUpdates.comment = "(would add)";
              const saasDryRunNextActions = opts.setStatus
                ? getNextActions(
                    opts.setStatus === "review"
                      ? "set-status:review"
                      : "set-status:in-progress",
                    editTargetId,
                  )
                : [];
              if (opts.json) {
                outputEnvelope({
                  ok: true,
                  json: opts.json,
                  payload: {
                    dryRun: true,
                    action: "update",
                    taskId: editTargetId,
                    updates: dryUpdates,
                    next_actions: saasDryRunNextActions,
                    ...noticeFields(editNotices),
                  },
                });
              } else {
                console.log(chalk.yellow("  [dry-run] Would update task:"));
                console.log(chalk.dim(`    id: ${editTargetId}`));
                for (const [k, v] of Object.entries(dryUpdates)) {
                  console.log(chalk.dim(`    ${k}: ${v}`));
                }
                if (saasDryRunNextActions.length > 0)
                  printNextHint(saasDryRunNextActions);
              }
              return;
            }

            // The PATCH carries the FULL resolved id — a prefix never
            // reaches the server (this was the reported bug: --edit sent
            // the raw prefix while --get resolved it).
            const saasResult = await updateSaasTask(editTargetId, saasPatch);
            if (!saasResult.ok) {
              // Like the --add path: a structured backend refusal (e.g.
              // INVALID_LINKS for a dangling parent) keeps its code so
              // CLI-online and hosted MCP refuse identically.
              const updateServerCode = saasResult.error.serverCode;
              if (opts.json) {
                outputEnvelope({
                  ok: false,
                  ...(updateServerCode
                    ? {
                        code: updateServerCode,
                        message: saasResult.error.message,
                      }
                    : {
                        ...saasFailure(saasResult.error),
                        message: `Failed to update task: ${editTargetId}`,
                      }),
                  json: opts.json,
                });
              } else if (updateServerCode) {
                console.log(chalk.red(`✗ ${saasResult.error.message}`));
              } else {
                console.log(chalk.red(`✗ Failed to update task: ${editTargetId}`));
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
                editTargetId,
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

            // A "cannot" verdict's reason lives in activity (system comment)
            // on the local path — the verified column is a tri-state boolean
            // on BOTH sides with no free-text reason field — so mirror it
            // here as a SaaS comment instead of dropping it. The caller is
            // told plainly it landed as a comment (not a field), so nobody
            // believes a reason column was written. A lost reason is the
            // same loss as a lost --comment, so it earns the same
            // E_COMMENT_SAVE refusal the local path uses.
            let saasVerifyReasonError: string | undefined;
            if (attestation.verdict === "cannot" && attestation.reason) {
              const recorded = await addSaasComment(
                editTargetId,
                `**Cannot verify:** ${attestation.reason}`,
              );
              if (recorded.ok) {
                if (!opts.json)
                  console.log(
                    chalk.dim("  verify reason: recorded as comment"),
                  );
              } else {
                saasVerifyReasonError = recorded.error.message;
                if (!opts.json) {
                  console.log(
                    chalk.red(
                      `✗ Verify reason was NOT recorded: ${saasVerifyReasonError}`,
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
                  editTargetId,
                )
              : [];
            if (opts.json) {
              // A comment is part of the TASK DATA: losing it leaves the
              // task genuinely incomplete, so this stays a refusal with a
              // non-zero exit — mirroring the local path's combined
              // commentError/verifyReasonError block under one code.
              const saasLost = saasCommentError
                ? {
                    message: `Task updated, but the comment was NOT saved: ${saasCommentError}`,
                    suggestion:
                      'Re-add the comment with --edit <task-id> --comment "..."',
                  }
                : saasVerifyReasonError
                  ? {
                      message: `Task updated, but the verify reason was NOT recorded: ${saasVerifyReasonError}`,
                      suggestion:
                        'Re-record it with --edit <task-id> --set-verify cannot --verify-reason "<why>"',
                    }
                  : null;
              if (saasLost) {
                outputEnvelope({
                  ok: false,
                  code: "E_COMMENT_SAVE",
                  message: saasLost.message,
                  suggestion: saasLost.suggestion,
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
          // The target was already resolved to its full id through the ONE
          // resolver above (exact id wins, UNIQUE prefix, E_AMBIGUOUS /
          // TASK_NOT_FOUND) — the write below takes the full id, so a
          // prefix can never hit an exact-match miss here while the gate
          // saw something else.
          const localProjectDir = resolve(dir);
          const resolvedTaskId = editTargetId;

          // Verify gate already checked above via checkReviewTransition

          if (opts.dryRun) {
            const dryUpdates: Record<string, unknown> = {};
            if (opts.title) dryUpdates.title = opts.title;
            if (opts.setStatus) dryUpdates.status = opts.setStatus;
            if (opts.description) dryUpdates.description = opts.description;
            if (dryRunReportName)
              dryUpdates.report = `${dryRunReportName} (would attach; source file kept)`;
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
          // The parent value resolves through the ONE resolver
          // (`resolveSaasTaskId`, shared with every other id-taking flag):
          // exact id wins, a UNIQUE prefix resolves, an ambiguous prefix is
          // E_AMBIGUOUS naming the candidates — never a silent first-match.
          // The pure helper then computes the new links (set/replace/clear
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
              const setParentResolved = resolveSaasTaskId(
                listTasks(localProjectDir).map((t) => ({
                  id: t.id,
                  title: t.title,
                })),
                rawParent,
              );
              if (!setParentResolved.ok) {
                const setParentSuggestion =
                  setParentResolved.code === "TASK_NOT_FOUND"
                    ? "Run 'vibeflow tasks' to see available task IDs."
                    : "Use the full task id — run 'vibeflow tasks' to see available task IDs.";
                const setParentMessage =
                  setParentResolved.code === "TASK_NOT_FOUND"
                    ? `Parent task not found: ${rawParent}`
                    : setParentResolved.message;
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    code: setParentResolved.code,
                    message: setParentMessage,
                    suggestion: setParentSuggestion,
                    json: opts.json,
                  });
                } else {
                  console.log(chalk.red(`✗ ${setParentMessage}`));
                  console.log(chalk.dim(`  ${setParentSuggestion}`));
                }
                process.exitCode =
                  setParentResolved.code === "TASK_NOT_FOUND"
                    ? ExitCode.NOT_FOUND
                    : ExitCode.USAGE;
                return;
              }
              const resolvedParentId = setParentResolved.id;
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

          // ── relates / blocks links (--relates / --blocks / --unrelates /
          // --unblocks) ───────────────────────────────────────────────────
          // Additive and surgical, matching the MCP addLinks/removeLinks
          // exactly: each flag is applied through the same pure helpers, in the
          // same order (adds then removes), against the state the previous
          // flag left behind. Nothing here can drop a link the caller did not
          // name — that guarantee is the whole reason these exist, and the CLI
          // previously could not express relates/blocks AT ALL.
          const linksAddRequests = [
            ...(opts.relates ?? []).map((raw) => ({
              raw,
              type: "relates" as const,
            })),
            ...(opts.blocks ?? []).map((raw) => ({
              raw,
              type: "blocks" as const,
            })),
          ];
          const linksRemoveRequests = [
            ...(opts.unrelates ?? []).map((raw) => ({
              raw,
              type: "relates" as const,
            })),
            ...(opts.unblocks ?? []).map((raw) => ({
              raw,
              type: "blocks" as const,
            })),
          ];

          if (linksAddRequests.length > 0 || linksRemoveRequests.length > 0) {
            // Every id-taking link flag resolves through the ONE resolver
            // (`resolveSaasTaskId`) BEFORE any link is touched: exact id
            // wins, a UNIQUE prefix resolves, an ambiguous prefix is
            // E_AMBIGUOUS naming the candidates — never a silent
            // first-match. A dangling target is refused here with the same
            // wording the SaaS path uses.
            const resolveEditLinkTargets = (
              requests: Array<{ raw: string; type: "relates" | "blocks" }>,
            ): Array<{ id: string; type: "relates" | "blocks" }> | null => {
              const resolvedRows = listTasks(localProjectDir).map((t) => ({
                id: t.id,
                title: t.title,
              }));
              const out: Array<{ id: string; type: "relates" | "blocks" }> =
                [];
              for (const req of requests) {
                const linkResolved = resolveSaasTaskId(
                  resolvedRows,
                  req.raw,
                );
                if (!linkResolved.ok) {
                  const linkMessage =
                    linkResolved.code === "TASK_NOT_FOUND"
                      ? `Task ${req.raw} not found`
                      : linkResolved.message;
                  const linkSuggestion =
                    linkResolved.code === "TASK_NOT_FOUND"
                      ? "Run 'vibeflow tasks' to see available task IDs."
                      : "Use the full task id — run 'vibeflow tasks' to see available task IDs.";
                  if (opts.json) {
                    outputEnvelope({
                      ok: false,
                      code: linkResolved.code,
                      message: linkMessage,
                      suggestion: linkSuggestion,
                      json: opts.json,
                    });
                  } else {
                    console.log(chalk.red(`✗ ${linkMessage}`));
                    console.log(chalk.dim(`  ${linkSuggestion}`));
                  }
                  process.exitCode =
                    linkResolved.code === "TASK_NOT_FOUND"
                      ? ExitCode.NOT_FOUND
                      : ExitCode.USAGE;
                  return null;
                }
                out.push({ id: linkResolved.id, type: req.type });
              }
              return out;
            };
            const resolvedAdds =
              resolveEditLinkTargets(linksAddRequests);
            if (!resolvedAdds) return;
            const resolvedRemoves = resolveEditLinkTargets(
              linksRemoveRequests,
            );
            if (!resolvedRemoves) return;
            const applyLinkChange = (): boolean => {
              // Fold whatever --set-parent already decided into the board the
              // helpers validate against, so a single call can move the parent
              // and add a relates link without one clobbering the other.
              let board = listTasks(localProjectDir);
              if (updates.links !== undefined) {
                board = board.map((t) =>
                  t.id === resolvedTaskId ? { ...t, links: updates.links } : t,
                );
              }

              const refuse = (
                reason: string,
                code: string,
              ): boolean => {
                if (opts.json) {
                  outputEnvelope({
                    ok: false,
                    code,
                    message: reason,
                    suggestion:
                      code === "TASK_NOT_FOUND"
                        ? "Run 'vibeflow tasks' to see available task IDs."
                        : undefined,
                    json: opts.json,
                  });
                } else {
                  console.log(chalk.red(`✗ ${reason}`));
                  console.log(
                    chalk.dim(
                      `  Run 'vibeflow tasks' to see available task IDs.`,
                    ),
                  );
                }
                process.exitCode =
                  code === "TASK_NOT_FOUND" ? ExitCode.NOT_FOUND : ExitCode.USAGE;
                return false;
              };

              for (const add of resolvedAdds) {
                const added = buildAddLinks({
                  allTasks: board,
                  taskId: resolvedTaskId,
                  incoming: [{ taskId: add.id, type: add.type }],
                });
                if (!added.ok) return refuse(added.reason, added.code);
                updates.links = added.links;
                board = board.map((t) =>
                  t.id === resolvedTaskId ? { ...t, links: added.links } : t,
                );
              }

              for (const remove of resolvedRemoves) {
                const removed = buildRemoveLinks({
                  allTasks: board,
                  taskId: resolvedTaskId,
                  remove: [{ taskId: remove.id, type: remove.type }],
                });
                if (!removed.ok) return refuse(removed.reason, removed.code);
                updates.links = removed.links;
                board = board.map((t) =>
                  t.id === resolvedTaskId ? { ...t, links: removed.links } : t,
                );
              }

              return true;
            };

            if (!applyLinkChange()) return;
          }

          // Warn when setting a Research task to in-progress — should not implement.
          // Also detect in-progress conflicts (task already claimed by another agent/user).
          if (opts.setStatus === "in-progress") {
            const projectDir = resolve(dir);
            // Exact lookup on the already-resolved id — never a second
            // prefix guess.
            const editedTask = listTasks(projectDir).find(
              (t) => t.id === editTargetId,
            );
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

          // The id was resolved above, so a miss here is only a
          // delete-between-reads race — still refused, never a guess.
          const updated = updateTask(dir, resolvedTaskId, updates);
          if (!updated) {
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "TASK_NOT_FOUND",
                message: `Task not found: ${editTargetId}`,
                suggestion: "Run 'vibeflow tasks' to see available task IDs.",
                json: opts.json,
              });
            } else {
              console.log(chalk.red(`✗ Task not found: ${editTargetId}`));
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
          // same `E_COMMENT_SAVE` refusal below rather than a warning printed
          // to stdout where a `--json` consumer cannot see it.
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
            }
          }

          // What this run LOST, decided once and consumed by every writer
          // below (human printer, --json envelope, auto-commit skip, exit
          // code). A comment is TASK DATA: losing it leaves the task genuinely
          // incomplete, so it is a refusal with a non-zero exit — never a
          // green success line that hides it. (A commit, by contrast, is a
          // VCS side-effect outside the task data, so that one stays a
          // notice; see the auto-commit block.)
          //
          // A lost `--verify-reason` is the same loss with the same remedy, so
          // it is the same code: one code, one meaning. Both wordings name the
          // remedy on BOTH surfaces.
          const lostWrite = commentError
            ? {
                message: `Task updated, but the comment was NOT saved: ${commentError}`,
                suggestion:
                  'Re-add the comment with --edit <task-id> --comment "..."',
              }
            : verifyReasonError
              ? {
                  message: `Task updated, but the verify reason was NOT recorded: ${verifyReasonError}`,
                  suggestion:
                    'Re-record it with --edit <task-id> --set-verify cannot --verify-reason "<why>"',
                }
              : undefined;

          // What the verdict write DID — stated because the caller cannot see
          // it in the task file. `cannot` leaves `verified` ABSENT by design
          // (tri-state: true = verified correct, false = verified WRONG,
          // absent = not assessed / no badge) and its reason lives in the
          // activity comment, not in a field, on either surface. So a reader
          // who opens the json sees no verdict and no reason field and cannot
          // tell "recorded" from "dropped" — which is exactly the
          // misdiagnosis that produced this fix: the verdict WAS recorded, on
          // annotated and unannotated tasks alike, while the success line said
          // nothing about it. One wording, used by the human line and the
          // --json payload so the two cannot disagree.
          const verifyOutcome =
            attestation.verdict === "pass"
              ? "verify: pass — recorded (verified=true)"
              : attestation.verdict === "fail"
                ? "verify: fail — recorded (verified=false; the review gate blocks it)"
                : attestation.verdict === "cannot"
                  ? "verify: cannot — no badge (verified left absent); reason recorded in activity"
                  : undefined;

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
            if (lostWrite) {
              // The status write DID land — so the refusal says both halves
              // instead of printing a green tick that hides the lost task
              // data behind an exit code a human never reads.
              console.log(chalk.red(`✗ ${lostWrite.message}`));
              console.log(chalk.dim(`  ${lostWrite.suggestion}`));
            } else {
              console.log(chalk.green(`✓ Task updated: ${updated.title}`));
              console.log(
                chalk.dim(`  id: ${updated.id} | status: ${updated.status}`),
              );
              if (parentDisplay !== undefined)
                console.log(chalk.dim(`  parent: ${parentDisplay}`));
              if (opts.comment?.trim())
                console.log(chalk.dim(`  comment: added`));
              // The verdict the store now holds — see verifyOutcome above.
              if (verifyOutcome)
                console.log(chalk.dim(`  ${verifyOutcome}`));
              if (localEditNextActions.length > 0)
                printNextHint(localEditNextActions);
            }
          }
          if (lostWrite) {
            if (opts.json) {
              outputEnvelope({
                ok: false,
                code: "E_COMMENT_SAVE",
                message: lostWrite.message,
                suggestion: lostWrite.suggestion,
                json: opts.json,
              });
            }
            process.exitCode = ExitCode.GENERAL;
          }

          // ── Auto-commit (runs after task status + comment are already saved) ──────
          // Keeping this after updateTask/addComment ensures comment is preserved even
          // when git commit fails. Failure sets exitCode=1 but does NOT undo the task.
          if (opts.setStatus === "review" && !lostWrite) {
            const autoDir = resolve(dir);
            const autoSettings = loadSettings(autoDir);
            if (autoSettings.autoCommit && opts.commitMessage?.trim()) {
              // Exact lookup on the already-resolved id — never a second
              // prefix guess (and absent for an online-only task with no
              // local clone, in which case there is nothing local to
              // commit and the block is skipped, as before).
              const taskForCommit = listTasks(autoDir).find(
                (t) => t.id === editTargetId,
              );
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
                  // A linked HEAD created no new commit, so "Committed" would
                  // be the same lie this fix removes — say what happened.
                  if (!opts.json) {
                    if (commitResult.linkedExisting) {
                      console.log(
                        chalk.green(
                          `✓ Already committed: ${opts.commitMessage.trim()} ${formatCommitTag(taskForCommit.id)}`,
                        ),
                      );
                      console.log(
                        chalk.dim(
                          `  linked HEAD: ${commitResult.sha} (nothing new to commit)`,
                        ),
                      );
                    } else {
                      console.log(
                        chalk.green(
                          `✓ Committed: ${opts.commitMessage.trim()} ${formatCommitTag(taskForCommit.id)}`,
                        ),
                      );
                      console.log(chalk.dim(`  sha: ${commitResult.sha}`));
                    }
                  }

                  if (autoSettings.autoPush) {
                    if (!opts.json) console.log(chalk.dim("  pushing..."));
                    const pushed = operations.tryAutoPush(autoDir, {
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
          // `verification` states the verdict this run wrote, in the SAME
          // wording the human line uses, because the store cannot show it:
          // `cannot` leaves `verified` absent and its reason lives in the
          // activity comment (see verifyOutcome above).
          if (opts.json && !lostWrite) {
            // --fields narrows the returned task (same selector the MCP
            // update_task `fields` takes; parity contract 83159002).
            const editFields = opts.fields
              ? opts.fields
                  .split(",")
                  .map((f: string) => f.trim())
                  .filter(Boolean)
              : [];
            // SAFETY: Task objects are plain JSON-serializable; Record<string, unknown> is the superset for field picking.
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: {
                task: pickFields(
                  updated as unknown as Record<string, unknown>,
                  editFields,
                ),
                ...(verifyOutcome
                  ? {
                      verification: {
                        verdict: attestation.verdict,
                        // null, not false: `cannot` writes ABSENCE, and a
                        // stored false would read as "verified WRONG".
                        verified: updated.verified ?? null,
                        ...(attestation.verdict === "cannot"
                          ? { reasonRecorded: true }
                          : {}),
                      },
                    }
                  : {}),
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

        // ── Reads through the operations layer (P2, ticket d7b9dc13) ──────
        // Every row below arrives through the named registered operations
        // (`listTasks` / `listAllTasksForCli`), which read through
        // `resolveReadPorts` — the ONE shared local-vs-remote authority the
        // MCP read operations use. This branch resolves no store on its own:
        // no `listTasksWithPaths`/`fetchSaasTasks` snapshot here, no inline
        // filter/scope/sort/limit reimplementation. A remote failure refuses
        // below (never a local fallback); envelopes are assembled by
        // `cli/renderers/task-reads.ts` from the operation result.
        // Behaviour notes vs the inline code this replaces:
        // - filtered remote queries now include matching children (the
        //   shared listing contract, ticket scope) instead of the old
        //   remote-only root scoping;
        // - `--all` is honoured in remote mode (bounded internal paging)
        //   instead of silently returning the default page;
        // - projections carry commentCount/fileCount from the read ports
        //   (ticket b2e56212), so nothing silently hides.
        const mode = await getMode();
        const listOpCtx: OperationContext = {
          projectDir: resolve(dir),
          mode: mode === "saas" ? "saas" : "local",
        };
        const listBackend = resolveReadBackend(mode);
        const taskLimit = resolveListLimit(opts.limit);
        const rawLimit =
          opts.limit === undefined ? undefined : parseInt(opts.limit, 10);
        const listInput = {
          // opts.status/type were validated above against the same
          // TASK_STATUSES / VALID_FILTER_TYPES vocabularies the operation
          // schema declares; the casts only satisfy the narrower input
          // type. --type matching stays case-insensitive inside the
          // shared listing model.
          status: opts.status as ListTasksInputType["status"],
          type: opts.type as ListTasksInputType["type"],
          user: opts.user,
          tag: opts.tag,
          children: opts.children,
        };
        // The operation takes the schema OUTPUT type (defaults applied):
        // an omitted --limit resolves to the default SILENTLY here — the
        // same answer the model gives for `undefined` — while an explicit
        // bad value (0/NaN) still passes through and rides the model LOUD
        // via `limitNotice`. `children` omitted and false are the same
        // query.
        const listResult = opts.all
          ? await operations.listAllTasksForCli(listOpCtx, {
              ...listInput,
              pageSize: taskLimit,
            })
          : await operations.listTasks(listOpCtx, {
              ...listInput,
              limit:
                rawLimit === undefined ? DEFAULT_LIST_LIMIT : rawLimit,
              children: opts.children ?? false,
            });
        // The ok arm carries data unconditionally (a valid page, possibly
        // empty); the second disjunct is unreachable fail-closed belt.
        if (!listResult.ok || !listResult.data) {
          const error = !listResult.ok
            ? listResult.error
            : {
                code: "LIST_TASKS_ERROR",
                message: "The board answered without rows — retry the listing.",
              };
          const refusal = operationRefusalEnvelope(error);
          if (opts.json) {
            outputEnvelope({ ...refusal, json: opts.json });
          } else {
            console.log(chalk.red(`✗ ${refusal.message}`));
            if (refusal.suggestion) {
              console.log(chalk.yellow(`  ${refusal.suggestion}`));
            }
          }
          process.exitCode = refusalExitCode(error.code);
          return;
        }
        const listed = listResult.data;
        const listNotices = listResult.steps ?? [];
        if (!opts.json)
          for (const notice of listNotices) console.error(notice.message);
        // --user validation against the board's author list, read through
        // the ports (the operation already applied the filter; this only
        // preserves the E_USAGE recovery naming the available users).
        if (opts.user) {
          const { store: userScopeStore } = resolveReadPorts(listOpCtx);
          const userScope = await userScopeStore.listTasks(
            listOpCtx.projectDir,
          );
          if (!validateUserFilter(opts.user, userScope, opts.json)) return;
        }
        if (listBackend === "remote") {

          if (opts.json) {
            // REMOTE MODE (ticket 9bb350a7): the legacy `tasks` +
            // `hiddenChildren` envelope, assembled by the read renderer
            // from the operation result — the position vocabulary
            // (offset/remaining/nextCursor/order) is a local-envelope
            // concern and is never invented here. Rows are the mapped
            // remote records through the shared listing model, so an
            // unfiltered listing still hides children and `--children`
            // still reveals them.
            outputEnvelope({
              ok: true,
              json: opts.json,
              payload: remoteListJsonPayload(listed, parsedFields),
            });
            return;
          }

          // Rows are the operation's mapped remote records (already
          // filtered/scoped/sorted/limited by the shared listing model).
          // Field notes vs the raw rows above: `created` (not createdAt),
          // comments carry `text` (not body), files carry names only (no
          // inlined content — content would cost a hydration request per
          // task, the N+1 the unhydrated listing removed), and list rows
          // carry no detail relations (parentId/children ride the --get
          // detail response, never the listing).
          // Counts ride the row as plain data (the mapped record carries
          // whatever the server sent); the Task TYPE does not name them,
          // so the read is spelled through this row alias, not any-casts.
          type RemoteListRow = Task & {
            commentCount?: number;
            fileCount?: number;
          };
          const remoteRows = listed.tasks as RemoteListRow[];
          const hasResearchTasks = remoteRows.some(
            (t) => (t.type ?? "").toLowerCase() === "research",
          );
          const hasBugTasks = remoteRows.some(
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

          if (remoteRows.length === 0) {
            console.log(chalk.dim("No tasks found."));
          } else {
            for (const [idx, task] of remoteRows.entries()) {
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
              console.log(chalk.dim(`    created:  ${task.created}`));
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
                  console.log(chalk.dim(`      [${c.author ?? "agent"}] ${c.createdAt}`));
                  for (const line of c.text.split("\n"))
                    console.log(chalk.dim(`        ${line}`));
                }
              } else if (
                typeof task.commentCount === "number" &&
                task.commentCount > 0
              ) {
                // Unhydrated listing: the list items carry counts, not
                // bodies — show the count instead of hiding the comments.
                console.log(
                  chalk.dim(`    comments (${task.commentCount})`),
                );
              }
              if (task.files && task.files.length > 0) {
                console.log(
                  chalk.dim(`    linked files (${task.files.length}):`),
                );
                for (const f of task.files) {
                  // Cloud-only URL: getApiUrl() is the remote base → always
                  // "cloud", so the legacy files path maps to /api/v0.
                  const fileUrl =
                    (f as { url?: string }).url ??
                    `${getApiUrl()}${surfacePath("cloud", `/api/tasks/${task.id}/files/${encodeURIComponent(f.name)}`)}`;
                  console.log(chalk.dim(`      - ${f.name}  ${fileUrl}`));
                }
              } else if (
                typeof task.fileCount === "number" &&
                task.fileCount > 0
              ) {
                // Unhydrated listing: the list items carry counts, not
                // rows — show the count instead of hiding the files.
                console.log(
                  chalk.dim(`    linked files (${task.fileCount})`),
                );
              }
              console.log();
            }

            // Board-wide status totals come from one ports snapshot (the
            // operation page carries scope counts, not per-status
            // columns) — human mode only, never on the --json path.
            const { store: countStore } = resolveReadPorts(listOpCtx);
            const allForCount = await countStore.listTasks(
              listOpCtx.projectDir,
            );
            // Never hide existence silently: name the flag that reveals the
            // children, the same disclosure the local listing prints.
            const saasChildSuffix =
              listed.hiddenChildren > 0
                ? chalk.dim(
                    ` · ${listed.hiddenChildren} child task${listed.hiddenChildren === 1 ? "" : "s"} hidden (use --children)`,
                  )
                : "";
            console.log(
              chalk.dim(formatStatusSummary(allForCount)) + saasChildSuffix,
            );
          }
          return;
        }

        // Local rendering from the same operation result — the remote
        // branch above already returned, so listBackend is "local" here.
        // Envelopes come from the read renderer, never a second snapshot.
        const filtered = listed.tasks;

        if (opts.json) {
          // Counts share the MCP vocabulary (totalMatching/totalRoots /
          // returned/limit(+limitNotice)/truncated/hint/hiddenChildren /
          // offset/remaining/nextCursor/order), read off the same shared
          // listing result the MCP tool returns. A --fields projection
          // carries commentCount/fileCount (ticket b2e56212) attached by
          // the operation from the read ports; the renderer keeps them.
          outputEnvelope({
            ok: true,
            json: opts.json,
            payload: {
              ...noticeFields(listNotices),
              ...localListJsonPayload(listed, parsedFields),
            },
          });
          return;
        }

        if (filtered.length === 0) {
          console.log(chalk.dim("No tasks found."));
          return;
        }

        const projectDir = resolve(dir);
        // Display support comes from the read ports — the same authority
        // the operation read — never a direct store import in this branch.
        // One full snapshot feeds the footer totals, the relations view,
        // and the per-task comment/file readers below.
        const { store: displayStore } = resolveReadPorts(listOpCtx);
        const displayScope = await displayStore.listTasks(projectDir);

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
          const structuredComments = (
            await displayStore.listComments(projectDir, task.id)
          ).sort(sortByCreatedAt);
          const linkedFiles = (
            await displayStore.listFiles(projectDir, task.id)
          ).map((f) => ({
            ...f,
            url: `http://localhost:${config.port}${f.url}`,
          }));
          const agent = formatTaskForAgent(
            task,
            structuredComments,
            linkedFiles,
          );
          printTaskDetails(
            {
              ...task,
              filePath:
                findTaskFilePath(projectDir, task.id) ?? "(unknown)",
            },
            agent,
            idx,
            config.port,
            projectDir,
            displayScope,
          );
        }

        // Ticket b2e56212: the footer echoes the shared hint (single
        // spelling, no second wording) — and an explicit --limit 0 is
        // resolved to the default LOUDLY, exactly like the --json
        // envelope's `limitNotice`.
        const limitSuffix = listed.truncated
          ? chalk.yellow(` (${listed.hint})`)
          : "";
        if (listed.limitNotice) {
          console.log(chalk.yellow(`  Note: ${listed.limitNotice}`));
        }
        // Never hide existence silently: name the flag that reveals the children.
        const childSuffix =
          listed.hiddenChildren > 0
            ? chalk.dim(
                ` · ${listed.hiddenChildren} child task${listed.hiddenChildren === 1 ? "" : "s"} hidden (use --children)`,
              )
            : "";
        console.log(
          chalk.dim(formatStatusSummary(displayScope)) + limitSuffix + childSuffix,
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

// ── Auth commands (online mode) ─────────────────────────────────────
// Decision (ticket b3b1ee24, 2026-10-17): `vibeflow auth {login,logout,status}`
// is the canonical spelling; bare `login`/`logout` stay as deprecated aliases
// that print a redirect notice and then run the same flow (never a silent
// break, never a silent removal). Internal identifiers (`getMode() === "saas"`,
// token storage, env vars) are untouched — only user-facing strings changed.
function printLoginDeprecationNotice(): void {
  console.log(
    chalk.yellow(
      "  Note: `vibeflow login` is deprecated — use `vibeflow auth login`.",
    ),
  );
}

function printLogoutDeprecationNotice(): void {
  console.log(
    chalk.yellow(
      "  Note: `vibeflow logout` is deprecated — use `vibeflow auth logout`.",
    ),
  );
}

program
  .command("login", { hidden: true })
  .description(
    "Deprecated alias of `vibeflow auth login` (device flow)",
  )
  .action(async () => {
    capture("command_run", { surface: "cli", command: "login" });
    await flushTelemetry();
    printLoginDeprecationNotice();
    await login();
  });

program
  .command("logout", { hidden: true })
  .description("Deprecated alias of `vibeflow auth logout`")
  .action(async () => {
    capture("command_run", { surface: "cli", command: "logout" });
    await flushTelemetry();
    printLogoutDeprecationNotice();
    await logout();
  });

/**
 * Shared `auth status` implementation: mode + logged-in account, never
 * secret values (only the board name, email and URL — the token is never
 * printed). Used by `vibeflow auth`, `vibeflow auth status` and the hidden
 * bare `vibeflow status` alias alike.
 */
async function showAuthStatus(opts: { json?: boolean }): Promise<void> {
    // `--json` exists because `status` grew non-zero exits (see the online branch
    // below). The json-refusal guard requires every non-zero exit to speak the
    // envelope, and the honest way to satisfy that is to give the command a
    // json surface rather than to allowlist the exits away.
    const mode = await getMode();

    if (mode === "local") {
      console.log(
        chalk.yellow("●  Not logged in") + chalk.dim("  (local mode)"),
      );
      console.log(
        chalk.dim("  Run ") +
          chalk.cyan("vibeflow auth login") +
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

    // Online mode
    const workspace = await readWorkspace();
    console.log(chalk.green("●  Online") + chalk.dim("  (online mode)"));
    if (workspace) {
      console.log(
        chalk.dim(
          `  Board:   ${workspace.icon ? `${workspace.icon} ` : ""}${workspace.name}`,
        ),
      );
      if (workspace.email)
        console.log(chalk.dim(`  Email:   ${workspace.email}`));
      console.log(chalk.dim(`  URL:     `) + chalk.cyan(workspace.url));
    } else {
      // Logged in but no board bound. Saying "Online" and then complaining
      // about the connection (which is what happened next, historically) sent
      // people chasing a network problem that did not exist.
      console.log(chalk.yellow("  No board selected yet."));
    }
    console.log();

    // Unhydrated: the status rollup needs statuses only.
    const saasData = await fetchSaasTasks(workspace?.id, { hydrate: false });
    if (!saasData.ok) {
      // Three genuinely different situations, previously all reported as
      // "Could not reach online backend. Check your connection." — which is
      // wrong for two of them and sent users debugging the wrong layer:
      //
      //   NOT_AUTHENTICATED  the stored token is gone/revoked  → re-login
      //   NETWORK_ERROR      the request never completed      → connection
      //   anything else      the server answered with an error → the server
      if (saasData.error.code === "NOT_AUTHENTICATED") {
        if (opts.json) {
          outputEnvelope({
            ok: false,
            code: "AUTH",
            message: "Not logged in.",
            suggestion: "vibeflow auth login",
            json: true,
          });
        } else {
          console.log(
            chalk.yellow("  ⚠  Not logged in. Run ") +
              chalk.cyan("vibeflow auth login") +
              chalk.yellow(" again."),
          );
        }
        process.exitCode = ExitCode.AUTH;
        return;
      }

      if (saasData.error.code === "NETWORK_ERROR") {
        // Transport failure: name it with the network message verbatim so
        // it stays distinguishable from a server refusal (HTTP_ERROR below).
        const networkDetail = `Could not reach online backend (${saasData.error.message}).`;
        if (opts.json) {
          outputEnvelope({
            ok: false,
            code: "NETWORK",
            message: networkDetail,
            retryable: true,
            suggestion: "Check your connection, then retry.",
            json: true,
          });
        } else {
          console.log(
            chalk.yellow(`  ⚠  ${networkDetail} Check your connection.`),
          );
        }
        process.exitCode = ExitCode.GENERAL;
        return;
      }

      if (!workspace) {
        // A perfectly healthy state: signed in, no board chosen yet, and the
        // backend demonstrably answered (we got an HTTP error, not a network
        // error, which is why we are here rather than in the branch above).
        // Report it plainly and succeed — the user has done nothing wrong and
        // there is no failure to signal.
        console.log(chalk.dim("  Skipped task counts — no board selected yet."));
        return;
      }

      if (opts.json) {
        outputEnvelope({
          ok: false,
          code: "API_ERROR",
          message: saasData.error.message,
          json: true,
        });
      } else {
        console.log(
          chalk.yellow(`  ⚠  Online request failed: ${saasData.error.message}`),
        );
      }
      process.exitCode = ExitCode.GENERAL;
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
  }

program
  .command("status", { hidden: true })
  .description("Deprecated alias of `vibeflow auth status`")
  .option("--json", "Emit machine-readable JSON instead of the human summary")
  .action(async (opts: { json?: boolean }) => {
    capture("command_run", { surface: "cli", command: "status" });
    await flushTelemetry();
    await showAuthStatus(opts);
  });

program
  .command("push", { hidden: true })
  .description(
    "Push local tasks to your online board (never touches the local store)",
  )
  .argument("[dir]", "Project root directory", ".")
  .option(
    "--board <boardId>",
    "Board to push to (wins over the saved board; required on a 2+ board account with no saved board — push refuses without a selection)",
  )
  .option(
    "--workspace <id>",
    "Target workspace ID (defaults to your first workspace)",
  )
  .option(
    "--prune-local",
    "Delete local task files for tasks that pushed cleanly (opt-in; verified per task)",
  )
  .option(
    "--keep-local-files",
    "[deprecated, now the default] Local files are always kept",
  )
  .option(
    "--dry-run",
    "Preview what would be pushed without making any changes",
  )
  .option(
    "--verbose",
    "Show the full skipped-link list instead of the grouped summary",
  )
  .option(
    "--json",
    "Emit the full push result (grouped refusals, all skipped links) as JSON on stdout",
  )
  .action(
    async (
      dir: string,
      opts: { board?: string; workspace?: string; pruneLocal?: boolean; keepLocalFiles?: boolean; dryRun?: boolean; verbose?: boolean; json?: boolean },
    ) => {
      capture("command_run", { surface: "cli", command: "push" });
      await push(dir, opts);
      await flushTelemetry();
    },
  );

program
  .command("pull")
  .description(
    "Pull the online board into your local task store (additive merge, never deletes)",
  )
  .argument("[dir]", "Project root directory", ".")
  .option(
    "--board <boardId>",
    "Board to pull from (wins over the saved board; required on a 2+ board account with no saved board — pull refuses without a selection)",
  )
  .option(
    "--out <dir>",
    "Project root to write into (default: the [dir] argument — the local store push reads)",
  )
  .option(
    "--prefer-remote",
    "On a conflicting field the REMOTE value wins (default: LOCAL wins, nothing is ever deleted; `status` always follows the remote record unless --prefer-local is passed)",
  )
  .option(
    "--prefer-local",
    "Restore local-wins for `status` (default: status follows the remote record — an offline status edit survives the next pull, but the store stops following the board for it)",
  )
  .option(
    "--dry-run",
    "Fetch and verify the archive, report the plan, write nothing",
  )
  .option(
    "--json",
    "Emit the pull result (added/merged/unchanged, files written) as JSON on stdout",
  )
  .action(
    async (
      dir: string,
      opts: { board?: string; out?: string; preferRemote?: boolean; preferLocal?: boolean; dryRun?: boolean; json?: boolean },
    ) => {
      capture("command_run", { surface: "cli", command: "pull" });
      await pull(dir, opts);
      await flushTelemetry();
    },
  );

const authors = program
  .command("authors")
  .description("Inspect and enrich commit-author attribution in the local task store");

authors
  .command("link")
  .description(
    "Resolve each task commit sha to its original git AUTHOR email (not the committer, not mailmap) and store it as the optional commit-level authorEmail.\n" +
      "  Fills only entries missing a value; a different existing value is reported as a conflict and NEVER overwritten. Never infers a task-level authorEmail and never touches the author text.\n" +
      "  Unresolvable shas (missing object, rewritten history, shallow clone, invalid email) are reported and left unchanged — nothing is fetched automatically. A second run is a no-op.\n" +
      "  Note: .vibeflow is git-tracked — run with --dry-run, review the diff, and commit the enrichment deliberately.",
  )
  .argument("[dir]", "Project root directory", ".")
  .option("--dry-run", "Report what would change without writing anything")
  .action(async (dir: string, opts: { dryRun?: boolean; json?: boolean }) => {
    capture("command_run", { surface: "cli", command: "authors link" });
    // Loaded on demand: a top-level import would run git/fs module init for
    // every command, which measurably delays the CLI's first output (and broke
    // a test that waits for the program to go quiet).
    const { authorsLink, formatAuthorsLinkResult } = await import(
      "./commands/authors.js"
    );
    const result = authorsLink(dir, opts);
    if (opts.json === true) console.log(JSON.stringify(result));
    else console.log(formatAuthorsLinkResult(result, opts.dryRun === true));
    // Enrichment that could not run is a FAILURE, not a success with a note:
    // `authors link && git commit` must not sail through after doing nothing.
    if (!result.gitAvailable) process.exitCode = ExitCode.GENERAL;
    await flushTelemetry();
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

const auth = program
  .command("auth")
  .description(
    "Manage online authentication: log in, out, and check status",
  )
  .option("--clear", "Delete all per-task encrypted auth state files")
  .option("--list", "List stored auth state files and their age")
  .option("--json", "With no subcommand: emit status as JSON")
  .action(
    async (opts: { clear?: boolean; list?: boolean; json?: boolean }) => {
      capture("command_run", { surface: "cli", command: "auth" });
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

    // Default: bare `vibeflow auth` shows the login status (same as
    // `vibeflow auth status`). The legacy --clear/--list cookie flags above
    // keep working unchanged.
    await showAuthStatus({ json: opts.json });
    },
  );

auth
  .command("login")
  .description("Log in with your online account (device flow)")
  .action(async () => {
    capture("command_run", { surface: "cli", command: "auth login" });
    await flushTelemetry();
    await login();
  });

auth
  .command("logout")
  .description("Log out: remove the stored token and return to local mode")
  .action(async () => {
    capture("command_run", { surface: "cli", command: "auth logout" });
    await flushTelemetry();
    await logout();
  });

auth
  .command("status")
  .description("Show online status and the logged-in account (never secrets)")
  .option("--json", "Emit machine-readable JSON instead of the human summary")
  .action(async (opts: { json?: boolean }) => {
    capture("command_run", { surface: "cli", command: "auth status" });
    await flushTelemetry();
    await showAuthStatus(opts);
  });

program
  .command("verify")
  .description(
    "Verify a task against its baseline snapshot. Before hand-parsing evidence JSON, explore the STATIC captured evidence with: verify style_query | style_diff | element_info | html_diff <task-id>",
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
  .option(
    "--timeout <ms>",
    `Bound this verification run in whole milliseconds (${VERIFY_TIMEOUT_MIN_MS}-${VERIFY_TIMEOUT_MAX_MS}; default ${VERIFY_TIMEOUT_DEFAULT_MS})`,
  )
  .action(
    async (
      args: string[],
      opts: {
        json?: boolean;
        url?: string;
        filter?: string;
        timeout?: string;
      },
    ) => {
      capture("command_run", { surface: "cli", command: "verify" });
      // Refused up front, before the task id is even looked at: a bad bound is
      // a usage error, not a verification failure.
      const timeoutMs = parseVerifyTimeout(opts.timeout, opts.json);
      if (timeoutMs === undefined) {
        await flushTelemetry();
        return;
      }
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
      // The ONE wall-clock bound for a CLI run: the same AbortController
      // `verify_task.timeoutMs` installs in core/operations.ts, handed to the
      // engine as the same `signal` that call passes. runVerify forwards its
      // opts object straight to verifyTask, which reads `signal` — so this is
      // the MCP path, not a second, divergent timeout mechanism layered next
      // to it.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      timer.unref?.();
      // Built as a variable (not an inline literal) because runVerify's
      // declared opts type predates `signal`; the engine's type carries it.
      const runOpts = { ...opts, signal: ac.signal };
      try {
        await runVerify(".", head, runOpts);
      } finally {
        clearTimeout(timer);
      }
      await flushTelemetry();
    },
  );

program
  .command("changelog")
  .description("Show the changelog — latest version by default")
  .option("--all", "Show the full changelog for every version")
  .action(async (opts: { all?: boolean }) => {
    capture("command_run", { surface: "cli", command: "changelog" });
    await flushTelemetry();
    showChangelog({ all: opts.all === true });
  });

program
  .command("openapi")
  .description("Print the bundled OpenAPI spec to stdout (no server needed)")
  .option("--yaml", "Emit the YAML form instead of JSON")
  .action(async (opts: { yaml?: boolean }) => {
    capture("command_run", { surface: "cli", command: "openapi" });
    await flushTelemetry();
    printOpenApi({ yaml: opts.yaml === true });
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
