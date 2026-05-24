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
  type?: 'comment' | 'system';
  /** True when the original comment was soft-deleted (trace is kept for history). */
  deleted?: boolean;
  /** Origin of the comment: 'cli' for terminal, 'web' for browser UI. */
  source?: 'cli' | 'web';
}

export interface TaskFileRef {
  name: string;
  addedAt: string;
  linkedPath?: string;
  mimeType?: string;
}

// ── Task system (.proto/tasks/{id}.json) ───────────────────────────────────
export type TaskStatus = "backlog" | "todo" | "in-progress" | "review" | "done";

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
  _testWorkspace?: { id: string; name: string; url: string; icon?: string | null; email?: string | null } | null;
  /** When true, suppress the "Press Ctrl+C to stop" hint from server startup output (caller will print it). */
  noCtrlCHint?: boolean;
}


