import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";
import type { Task, TaskStatus, TaskComment } from "./types.js";
import {
  PROTO_DIR,
  TASKS_DIR,
  FILES_DIR,
  SCREENSHOTS_DIR,
} from "./types.js";
import type { FileInfo } from "./files.js";
const VALID_STATUSES: TaskStatus[] = ["backlog", "todo", "in-progress", "review", "done"];

export function generateTaskId(): string {
  // 15 random bytes → 30-char lowercase hex, 120 bits of entropy — essentially zero collision probability
  return randomBytes(15).toString("hex");
}

// ── Directory helpers ──────────────────────────────────────────────────────
export function getTasksDir(projectDir: string): string {
  return join(projectDir, PROTO_DIR, TASKS_DIR);
}

function migrateLegacyTaskAssetFolders(projectDir: string): void {
  const protoRoot = join(projectDir, PROTO_DIR);
  const legacyFilesDir = join(protoRoot, "files");
  const nextFilesDir = join(protoRoot, FILES_DIR);
  const legacyScreenshotsDir = join(protoRoot, "screenshots");
  const nextScreenshotsDir = join(protoRoot, SCREENSHOTS_DIR);

  if (existsSync(legacyFilesDir)) {
    mkdirSync(nextFilesDir, { recursive: true });
    for (const entry of readdirSync(legacyFilesDir)) {
      const from = join(legacyFilesDir, entry);
      const to = join(nextFilesDir, entry);
      if (existsSync(to)) continue;
      try { renameSync(from, to); } catch { /* ignore migration collisions */ }
    }
  }

  if (existsSync(legacyScreenshotsDir)) {
    mkdirSync(nextScreenshotsDir, { recursive: true });
    for (const entry of readdirSync(legacyScreenshotsDir)) {
      const from = join(legacyScreenshotsDir, entry);
      const to = join(nextScreenshotsDir, entry);
      if (existsSync(to)) continue;
      try { renameSync(from, to); } catch { /* ignore migration collisions */ }
    }
  }
}

export function ensureTaskDirs(projectDir: string): void {
  migrateLegacyTaskAssetFolders(projectDir);
  mkdirSync(getTasksDir(projectDir), { recursive: true });
  mkdirSync(join(projectDir, PROTO_DIR, SCREENSHOTS_DIR), { recursive: true });
}

// ── JSON-based storage helpers ─────────────────────────────────────────────

/** Extracts the YYYY-MM-DD date component from an ISO date string. */
function getDateSubdir(isoDate: string): string {
  return isoDate.slice(0, 10);
}

/**
 * Returns the canonical JSON file path for a task.
 * When `created` is provided, the file lives in a date subdirectory.
 * Falls back to the flat layout when no date is given (legacy lookup).
 */
export function getTaskFilePath(projectDir: string, taskId: string, created?: string): string {
  const tasksDir = getTasksDir(projectDir);
  if (created) {
    return join(tasksDir, getDateSubdir(created), `${taskId}.json`);
  }
  return join(tasksDir, `${taskId}.json`);
}

/**
 * Resolves the actual path of an existing task file by ID.
 * Searches date subdirectories first, then falls back to the legacy flat layout.
 */
export function findTaskFilePath(
  projectDir: string,
  taskId: string,
): string | null {
  const tasksDir = getTasksDir(projectDir);
  if (!existsSync(tasksDir)) return null;

  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const candidate = join(tasksDir, entry.name, `${taskId}.json`);
      if (existsSync(candidate)) return candidate;
    } else if (entry.name === `${taskId}.json`) {
      return join(tasksDir, entry.name);
    }
  }
  return null;
}

function normalizeTask(raw: Record<string, unknown>): Task {
  const normalizedType = (() => {
    if (typeof raw.type !== "string") return undefined;
    const t = raw.type.trim();
    if (!t || t === "[object Object]") return undefined;
    return t;
  })();

  return {
    id: String(raw.id ?? ""),
    title: String(raw.title ?? "Untitled"),
    description: String(raw.description ?? ""),
    status: (VALID_STATUSES.includes(raw.status as TaskStatus) ? raw.status : "todo") as TaskStatus,
    url: raw.url ? String(raw.url) : undefined,
    selector: (() => {
      const sel = String(raw.selector ?? "/");
      // Legacy migration: old tasks stored file:line as selector without a separate cssSelector.
      // When cssSelector is present, the task was created by the modern system that tracks
      // both selector and cssSelector independently — do NOT overwrite the selector in that case.
      if (raw.file && !raw.cssSelector && sel.startsWith(String(raw.file))) {
        return raw.url ? String(raw.url) : "/";
      }
      return sel;
    })(),
    cssSelector: raw.cssSelector && String(raw.cssSelector) !== String(raw.selector ?? "/")
      ? String(raw.cssSelector) : undefined,
    file: raw.file ? String(raw.file) : undefined,
    line: raw.line != null ? Number(raw.line) : undefined,
    col: raw.col != null ? Number(raw.col) : undefined,
    component: raw.component ? String(raw.component) : undefined,
    type: normalizedType,
    priority: raw.priority ? String(raw.priority) : undefined,
    ...(raw.reportBack === true && { reportBack: true }),
    agent: raw.agent ? String(raw.agent) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    author: raw.author ? String(raw.author) : undefined,
    commits: Array.isArray(raw.commits)
      ? (raw.commits as Record<string, unknown>[]).map((c) => ({
          sha: String(c.sha ?? ""),
          message: String(c.message ?? ""),
          timestamp: String(c.timestamp ?? new Date().toISOString()),
        }))
      : undefined,
    created: String(raw.created ?? new Date().toISOString()),
    updated: raw.updated ? String(raw.updated) : undefined,
    comments: Array.isArray(raw.comments)
      ? (raw.comments as Record<string, unknown>[]).map((c) => ({
          ...(c as unknown as TaskComment),
          // Normalize legacy 'content' field → 'text' (some older agent comments used 'content')
          text: (c.text as string | undefined) ?? (c.content as string | undefined) ?? "",
        }))
      : [],
    files: Array.isArray(raw.files)
      ? (raw.files as Array<Record<string, unknown> | string>).map((f) => {
          if (typeof f === "string") {
            return { name: f, addedAt: new Date().toISOString() };
          }
          return {
            name: String(f.name ?? ""),
            addedAt: String(f.addedAt ?? new Date().toISOString()),
            linkedPath: f.linkedPath ? String(f.linkedPath) : undefined,
            mimeType: f.mimeType ? String(f.mimeType) : undefined,
          };
        }).filter((f) => f.name)
      : [],
    screenshot: raw.screenshot ? String(raw.screenshot) : undefined,
    annotatedElementText: raw.annotatedElementText ? String(raw.annotatedElementText) : undefined,
    tags: Array.isArray(raw.tags)
      ? (raw.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0)
      : undefined,
    sortKey: raw.sortKey ? String(raw.sortKey) : undefined,
  };
}

function writeTaskJson(projectDir: string, task: Task): void {
  const dateDir = join(getTasksDir(projectDir), getDateSubdir(task.created));
  mkdirSync(dateDir, { recursive: true });
  const filePath = join(dateDir, `${task.id}.json`);
  // Write to a temp file then rename for atomic replacement (prevents torn reads).
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(task, null, 2), "utf-8");
  renameSync(tmp, filePath);
}

// ── CRUD operations ────────────────────────────────────────────────────────

/**
 * Converts literal escape sequences (common when agents or scripts pass text
 * via shell arguments) into their actual character equivalents.  Real newlines,
 * tabs, etc. pass through unchanged so human-created text is never affected.
 * Uses a single-pass regex to correctly preserve `\\n` as a literal backslash + n.
 *
 * Exported so that `comments.ts` (which already imports from this module) can
 * reuse the same logic without circular dependencies.
 */
export function normalizeEscapeSequences(text: string): string {
  return text.replace(/\\(n|t|r|\\)/g, (_, c: string): string => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      default: return c;
    }
  });
}

export function createTask(
  projectDir: string,
  input: Omit<Task, "id" | "created" | "comments" | "files">,
): Task {
  const normalizedPriority = (() => {
    const raw = (input.priority ?? "").trim().toLowerCase();
    if (raw === "critical") return "Critical";
    if (raw === "high") return "High";
    if (raw === "low") return "Low";
    return "Medium";
  })();

  const task: Task = {
    ...input,
    title: normalizeEscapeSequences(input.title ?? "").trim(),
    description: normalizeEscapeSequences(input.description ?? "").trim(),
    priority: normalizedPriority,
    id: generateTaskId(),
    created: new Date().toISOString(),
    comments: [],
    files: [],
  };
  writeTaskJson(projectDir, task);
  return task;
}

/** Reads and parses a task JSON file. */
export function readTaskFile(filePath: string): Task | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    if (filePath.endsWith(".json")) {
      const raw = JSON.parse(content) as unknown;
      if (!raw || typeof raw !== "object" || !("id" in raw)) return null;
      return normalizeTask(raw as Record<string, unknown>);
    }
    return null;
  } catch {
    return null;
  }
}

function collectTaskFiles(projectDir: string): Array<{ task: Task; filePath: string }> {
  const tasksDir = getTasksDir(projectDir);
  if (!existsSync(tasksDir)) return [];

  const results: Array<{ task: Task; filePath: string }> = [];
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const dateDir = join(tasksDir, entry.name);
      for (const file of readdirSync(dateDir)) {
        if (extname(file) === ".json") {
          const filePath = join(dateDir, file);
          const task = readTaskFile(filePath);
          if (task) results.push({ task, filePath });
        }
      }
    } else if (extname(entry.name) === ".json") {
      const filePath = join(tasksDir, entry.name);
      const task = readTaskFile(filePath);
      if (task) results.push({ task, filePath });
    }
  }
  return results;
}

export function listTasks(projectDir: string): Task[] {
  return collectTaskFiles(projectDir).map(({ task }) => task);
}

export function listTasksWithPaths(
  projectDir: string,
): Array<Task & { filePath: string }> {
  return collectTaskFiles(projectDir).map(({ task, filePath }) => ({ ...task, filePath }));
}

export function updateTask(
  projectDir: string,
  taskId: string,
  updates: Partial<Omit<Task, "id" | "created">>,
): Task | null {
  const existingPath = findTaskFilePath(projectDir, taskId);
  const task = existingPath ? readTaskFile(existingPath) : null;
  if (!task) return null;

  const updated: Task = { ...task, ...updates, updated: new Date().toISOString() };
  writeTaskJson(projectDir, updated);
  // If the task moved from flat layout to date-based, remove the old flat file
  if (existingPath && existingPath !== getTaskFilePath(projectDir, taskId, updated.created)) {
    try { unlinkSync(existingPath); } catch { /* ignore */ }
  }
  return updated;
}

export function deleteTask(projectDir: string, taskId: string): boolean {
  const filePath = findTaskFilePath(projectDir, taskId);
  if (!filePath) return false;
  unlinkSync(filePath);
  return true;
}

/**
 * Returns only the fields relevant to a coding agent for a single task.
 *
 * Use this function inside the `tasks` CLI command output and anywhere else
 * that coding agents consume task data (e.g. export prompts, MCP tools).
 * Deliberately excludes: cssSelector (redundant), updated/removed timestamps
 * (noise).
 */
export interface AgentTask {
  id: string;
  status: string;
  title: string;
  description: string;
  url?: string;
  selector: string;
  file?: string;
  line?: number;
  col?: number;
  component?: string;
  type?: string;
  priority?: string;
  /** Structured threaded comments embedded in the task JSON. */
  structuredComments?: TaskComment[];
  /** Files attached to this task (linked via the UI or API). */
  linkedFiles?: FileInfo[];
  /** When true, add a comment with your implementation report after completing this task. */
  reportBack?: boolean;
  created: string;
}

export function formatTaskForAgent(
  task: Task,
  comments?: TaskComment[],
  files?: FileInfo[],
): AgentTask {
  return {
    id: task.id,
    status: task.status,
    title: task.title,
    description: task.description,
    ...(task.url && { url: task.url }),
    selector: task.selector,
    ...(task.file && { file: task.file }),
    ...(task.line != null && { line: task.line }),
    ...(task.col != null && { col: task.col }),
    ...(task.component && { component: task.component }),
    ...(task.type && { type: task.type }),
    ...(task.priority && { priority: task.priority }),
    ...(comments && comments.length > 0 && { structuredComments: comments }),
    ...(files && files.length > 0 && { linkedFiles: files }),
    ...(task.reportBack && { reportBack: true }),
    created: task.created,
  };
}

/**
 * Renders a task, its comments, and linked files into the exact plain-text
 * format produced by `vibeflow tasks --get`. This is shared between the CLI
 * `--get` command and the server agent-run endpoint so agents always receive
 * identical instructions.
 */
export function renderTaskForAgent(
  task: Task,
  taskFilePath: string,
  comments: TaskComment[],
  files: FileInfo[],
  projectDir: string,
): string {
  const lines: string[] = [];

  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`[${task.status}] ${task.title}`);
  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`    id:       ${task.id}`);
  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`    file:     ${taskFilePath}`);
  if (task.file) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    source:   ${task.file}${task.line != null ? `:${task.line}` : ""}${task.col != null ? `:${task.col}` : ""}`);
  }
  if (task.component) lines.push(`    component: ${task.component}`);
  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`    selector: ${task.selector ?? "/"}`);
  if (task.cssSelector) lines.push(`    css:      ${task.cssSelector}`);
  if (task.url) lines.push(`    url:      ${task.url}`);
  if (task.commits && task.commits.length > 0) {
    if (task.commits.length === 1) {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`    commit:   ${task.commits[0].sha}`);
    } else {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`    commits (${task.commits.length}):`);
      for (const c of task.commits) {
        // Stryker disable once StringLiteral: display format for task rendering
        lines.push(`      ${c.sha.slice(0, 8)}  ${c.timestamp}  ${c.message.slice(0, 60)}`);
      }
    }
  }
  // Stryker disable once StringLiteral: display format for task rendering
  lines.push(`    created:  ${task.created}`);
  if (task.type) lines.push(`    type:     ${task.type}`);
  if (task.priority) lines.push(`    priority: ${task.priority}`);
  if (task.author) lines.push(`    author:   ${task.author}`);
  if (task.description) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    description:`);
    for (const line of task.description.split("\n")) lines.push(`      ${line}`);
  }
  if (task.annotatedElementText) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    element text: ${task.annotatedElementText}`);
  }
  if (comments.length > 0) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    comments (${comments.length}):`);
    for (const c of comments) {
      const edited = c.updatedAt ? ` (edited ${c.updatedAt})` : "";
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`      [${c.author ?? "user"}] ${c.createdAt}${edited}`);
      for (const line of c.text.split("\n")) lines.push(`        ${line}`);
    }
  }
  if (files.length > 0) {
    // Stryker disable once StringLiteral: display format for task rendering
    lines.push(`    linked files (${files.length}):`);
    for (const f of files) {
      // Stryker disable once StringLiteral: display format for task rendering
      lines.push(`      - ${f.name}  ${f.url}`);
      const absPath = f.linkedPath ?? join(projectDir, ".vibeflow", "files", task.id, f.name);
      if (/\.(md|txt)$/i.test(f.name) && f.size < 100_000 && existsSync(absPath)) {
        try {
          const content = readFileSync(absPath, "utf-8");
          // Stryker disable once StringLiteral: display format for task rendering
          lines.push(`        ┌── content ──`);
          for (const line of content.split("\n")) lines.push(`        │  ${line}`);
          // Stryker disable once StringLiteral: display format for task rendering
          lines.push(`        └─────────────`);
        } catch { /* file read failed – show URL only */ }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Renders agent workflow instructions as plain text (no ANSI colors).
 * This is the text counterpart to the console-formatted instructions shown
 * by `vibeflow tasks --get`, and is appended to the agent prompt so the
 * LLM knows the project workflow, settings, and constraints.
 */
export function renderAgentInstructions(opts: {
  hasResearchTasks: boolean;
  hasBugTasks?: boolean;
  autoCommit?: boolean;
  autoPush?: boolean;
  autoComment?: boolean;
  createBranch?: boolean;
}): string {
  const { autoCommit, autoPush, autoComment, createBranch } = opts;
  const lines: string[] = [];

  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("Agent instructions (concise):");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  Discover: vibeflow tasks --status todo   |  vibeflow tasks --type Research   |  vibeflow tasks --user <email>  |  vibeflow tasks --tag <tag>");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  Auto-claim: vibeflow tasks --next  (picks highest-priority todo task and sets it in-progress automatically)");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  Details:  vibeflow tasks --get <id>  (full task info with comments and files)");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  Create:   vibeflow tasks --add --title \"...\" --description \"...\"");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  Workflow:");
  if (createBranch) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    ⚠ Create a branch FIRST, before any implementation:");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    1. git checkout -b <short-name>  (e.g. fix/annotation-errors, feat/eye-toggle, chore/cleanup-extension)");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("       Branch name rules: lowercase, kebab-case, 2-5 words, prefix fix/feat/chore/docs.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("       Describe the WORK done (not dates). Bad: agent/2026-04-16. Good: fix/bug-errors-visibility.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    2. vibeflow tasks --edit <id> --set-status in-progress  ← CLAIM TASK");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    3. <implement the change>");
  } else {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    ⚠ IMMEDIATELY set in-progress BEFORE any implementation work:");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    1. vibeflow tasks --edit <id> --set-status in-progress  ← DO THIS FIRST");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("       (if you used --next: task is already in-progress — skip to step 2)");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    2. <implement the change>");
  }
  if (autoCommit) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(createBranch ? "    4. git add <files>   (stage your changes first)" : "    3. git add <files>   (stage your changes first)");
    const reviewArgs = ["--set-status review"];
    if (autoCommit) reviewArgs.push('--commit-message "<one-line summary>"');
    if (autoComment) reviewArgs.push('--comment "<report>"');
    lines.push(`    ${createBranch ? "5" : "4"}. vibeflow tasks --edit <id> ${reviewArgs.join(" ")}`);
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("       CLI will commit staged changes and link the commit SHA automatically.");
  } else {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push(createBranch ? "    4. git add <files> && vibeflow tasks --commit --task <id> --message \"<one-line summary>\"" : "    3. git add <files> && vibeflow tasks --commit --task <id> --message \"<one-line summary>\"");
    const reviewArgs = ["--set-status review"];
    if (autoComment) reviewArgs.push('--comment "<report>"');
    lines.push(`    ${createBranch ? "5" : "4"}. vibeflow tasks --edit <id> ${reviewArgs.join(" ")}`);
  }
  if (autoComment) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  Comment format (--comment):");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Plain text for concise one-liners.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Markdown for multi-section reports. Use **bold**, bullet lists, code fences.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Must cover: what changed, why, key decisions, anything future agents should know.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · For long reports, attach a .md file and reference it in the comment.");
  }
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("");

  if (autoCommit) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  [setting] Auto-commit ON: provide --commit-message when setting status to review; CLI commits.");
  }
  if (autoPush) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  [setting] Auto-push ON: CLI pushes after the commit automatically.");
  }
  if (autoComment) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  [setting] Auto-comment ON: --comment is required when setting status to review.");
  }
  if (createBranch) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  [setting] Create branch ON: all work goes on a dedicated branch created before implementation.");
  }
  if (opts.hasResearchTasks) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  Research tasks: NEVER generate code — research only.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    Attach a .md report before marking Research tasks as review.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    CLI ENFORCES: cannot mark Research as review without an attached .md report.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    Create the report file locally first, then upload when marking as review:");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("      vibeflow tasks --edit <id> --set-status review --report-file ./report.md --comment \"...\"");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    The file is saved next to the task and deleted from the original path automatically.");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    Report must include: findings, options considered (with pros/cons), recommendation, sources.");
  }
  if (opts.hasBugTasks) {
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("  Bug tasks: Reproduce the bug first, then include in the comment:");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Symptom: what the user sees");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Trigger: exact steps to reproduce");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Root cause: the specific code/logic that caused it");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Fix: what was changed and why it works");
    // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
    lines.push("    · Evidence: paste the relevant error message or stack trace");
  }
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  BLOCKED? If a task is unclear or missing context:");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    vibeflow tasks --edit <id> --comment \"Blocked: <reason>. Need: <what is needed>.\"");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    Then pick the next task: vibeflow tasks --next");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    Do not guess at unclear requirements — leave a comment and move on.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  CRITICAL: NEVER edit .vibeflow/ task files directly.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    All task operations (status, comments, commits) must go through CLI commands.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  CRITICAL: Set in-progress BEFORE reading/planning. Other agents may pick the same task.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    The in-progress transition signals ownership. Skip it and another agent may duplicate your work.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    Sequence: discover tasks → pick one → set in-progress → THEN read details and implement.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("  CRITICAL: NEVER set a task status to \"done\".");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    When your implementation is complete, set the status to \"review\" — not \"done\".");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    Only humans can mark tasks as done after reviewing the work.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("    The CLI will warn you and still allow the change — but agents must not use it.");
  // Stryker disable once StringLiteral: display text for agent instructions - semantically equivalent
  lines.push("");

  return lines.join("\n");
}

// ── Migration: convert old .md + .json comments to new JSON format ─────────

/**
 * Migrates all legacy `.md` task files (+ separate comment JSON files) in a
 * project to the new single-file `.proto/tasks/{id}.json` format.
 * Idempotent: already-migrated tasks are skipped.
 */

// ── Migration: flat JSON → date-based directories ──────────────────────────

/**
 * Moves all flat `.proto/tasks/{id}.json` files into date-based subdirectories.
 * Idempotent: files already in a date directory are skipped.
 * Returns the number of files moved.
 */
export function migrateFlatTasksToDateDirs(projectDir: string): number {
  const tasksDir = getTasksDir(projectDir);
  if (!existsSync(tasksDir)) return 0;

  let moved = 0;
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue; // already in a date dir
    if (extname(entry.name) !== ".json") continue;

    const flatPath = join(tasksDir, entry.name);
    const task = readTaskFile(flatPath);
    if (!task) continue;

    const dateDir = join(tasksDir, getDateSubdir(task.created));
    const datePath = join(dateDir, entry.name);
    if (flatPath === datePath) continue; // already in the right place (shouldn't happen)

    mkdirSync(dateDir, { recursive: true });
    writeFileSync(datePath, JSON.stringify(task, null, 2), "utf-8");
    unlinkSync(flatPath);
    moved++;
  }
  return moved;
}


