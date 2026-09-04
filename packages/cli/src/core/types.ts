// ── Task comments ──────────────────────────────────────────────────────────
export type CommentAuthor = "user" | "agent";

export interface TaskCommit {
  sha: string;
  message: string;
  timestamp: string;
}

export interface TaskComment {
  id: string;
  author: CommentAuthor;
  text: string;
  /** Filenames attached to this comment (stored under .proto/files/{taskId}/). */
  files?: string[];
  createdAt: string;
  updatedAt?: string;
  /** 'system' entries are auto-generated traces (file removed, comment deleted, etc.). */
  type?: "comment" | "system";
  /** True when the original comment was soft-deleted (trace is kept for history). */
  deleted?: boolean;
  /** Origin of the comment: 'cli' for terminal, 'web' for browser UI. */
  source?: "cli" | "web";
}

export interface TaskFileRef {
  name: string;
  addedAt: string;
  linkedPath?: string;
  mimeType?: string;
}

// ── Task system (.proto/tasks/{id}.json) ───────────────────────────────────
export const TASK_STATUSES = ["backlog", "todo", "in-progress", "review", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Returns true if the value is a valid TaskStatus. */
export function isTaskStatus(v: unknown): v is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(v as string);
}

/** Priority rank for sorting: critical=0, high=1, medium/default=2, low=3. Case-insensitive. */
export function getPriorityRank(priority?: string): number {
  const value = (priority ?? "Medium").trim().toLowerCase();
  if (value === "critical") return 0;
  if (value === "high") return 1;
  if (value === "low") return 3;
  return 2; // medium/default
}

/** Comparator: priority tier first (ascending), then created timestamp ascending (oldest first). */
export function compareTasksByPriorityThenCreated<
  T extends { priority?: string; created: string },
>(a: T, b: T): number {
  const pa = getPriorityRank(a.priority);
  const pb = getPriorityRank(b.priority);
  if (pa !== pb) return pa - pb;
  return new Date(a.created).getTime() - new Date(b.created).getTime();
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  url?: string;
  selector: string;
  cssSelector?: string;
  /** Source file path resolved from framework internals (Tier 1). */
  file?: string;
  /** 1-indexed source line (React _debugSource only). */
  line?: number;
  /** 1-indexed source column (React _debugSource only). */
  col?: number;
  /** Nearest named component resolved from framework internals. */
  component?: string;
  type?: string;
  priority?: string;
  /** When true, the task was successfully verified. */
  verified?: boolean;
  /** When true, the agent must add a comment with a report after completing the task. */
  reportBack?: boolean;
  /** Preferred coding agent name for this task. */
  agent?: string;
  /** Preferred LLM model for this task. */
  model?: string;
  /** Git username of the task author. */
  author?: string;
  /** All implementing commits linked to this task (newest last). */
  commits?: TaskCommit[];
  created: string;
  updated?: string;
  /** Embedded comments (replaces the separate .proto/comments/ directory). */
  comments?: TaskComment[];
  /** Attached files (uploaded files and absolute-path links). */
  files?: TaskFileRef[];
  /** Screenshot filename (e.g. "{taskId}.png") stored in .proto/screenshots/. */
  screenshot?: string;
  /** Inner text of the annotated element (captured from the browser, max 300 chars). */
  annotatedElementText?: string;
  /** Free-form tags for categorization and filtering. */
  tags?: string[];
  /** Fractional sort key for kanban column ordering. */
  sortKey?: string;
  /** Git branch name created for this task (when createBranch setting is ON). */
  branchName?: string;
  /** Baseline DOM snapshot captured at annotation time (§6). @deprecated Use baselineElementFile for new tasks. */
  baseline?: import("./verification-types.js").DomSnapshot;
  /** Single-element baseline snapshot file (annotation time). */
  baselineElementFile?: string;
  /** Page-wide baseline snapshot file (annotation time). */
  baselineFile?: string;
  /** Encrypted auth state as a JSON string (§7), encrypted with task author's key. */
  authStateEnc?: string;
}

export interface ProtoConfig {
  port: number;
}

export const PROTO_DIR = ".vibeflow";
export const TASKS_DIR = "tasks";
export const FILES_DIR = "tasks/files";
// Stryker disable once StringLiteral: directory path constant used throughout the codebase
export const SCREENSHOTS_DIR = "tasks/screenshots";
export const CONFIG_FILE = "config.json";

// ── Serve options ──────────────────────────────────────────────────────────
export interface ServeOptions {
  port: number;
  open: boolean;
  /** Bind hostname (default: 'localhost'). Use '0.0.0.0' to expose on all interfaces for LAN sharing. */
  host?: string;
  /** When true, the server serves raw HTML without injecting the overlay script. */
  noOverlay?: boolean;
  /** Override project directory for API-only mode (defaults to process.cwd()). */
  projectDir?: string;
  /** @internal Testing only: inject a mock token to simulate SaaS online mode (undefined = read from ~/.vibeflow/token). */
  _testToken?: string | null;
  /** @internal Testing only: inject a mock workspace to simulate SaaS online mode (undefined = read from ~/.vibeflow/workspace). */
  _testWorkspace?: {
    id: string;
    name: string;
    url: string;
    icon?: string | null;
    email?: string | null;
  } | null;
  /** When true, suppress the "Press Ctrl+C to stop" hint from server startup output (caller will print it). */
  noCtrlCHint?: boolean;
}
