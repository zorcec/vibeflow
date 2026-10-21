import type { Principal } from "@vibeflow-tools/api-core";

// ── Task comments ──────────────────────────────────────────────────────────
export type CommentAuthor = "user" | "agent";

// ── Task links (parent / relates / blocks) ──────────────────────────────
// Canonical home is `@vibeflow-tools/api-core` (P4a decision (B): both the
// local and the hosted surface consume the same vocabulary); re-exported
// here so CLI-internal importers do not churn.
import {
  TASK_LINK_TYPES,
  TASK_STATUSES,
  type TaskLinkType,
  type TaskStatus,
} from "@vibeflow-tools/api-core";
export { TASK_LINK_TYPES, TASK_STATUSES, type TaskLinkType, type TaskStatus };

/**
 * Documented task-type vocabulary — the store's schema boundary for `type`.
 *
 * The same five values the `tasks --type` filter accepts (Task, Bug, Feature,
 * Enhancement, Research). Anything else persisted as `type` — a stringified
 * object, a retired value, any other string — is not a type the product
 * models: readers treat it as ABSENT (see `normalizeTaskTypeValue` in
 * `core/tasks.ts`) so it can never round-trip back out, and
 * `tasks --normalize` drops the key from existing records.
 */
export const TASK_TYPE_VALUES = [
  "Task",
  "Bug",
  "Feature",
  "Enhancement",
  "Research",
] as const;

/** One of the documented task-type values. */
export type TaskTypeValue = (typeof TASK_TYPE_VALUES)[number];

export interface TaskLink {
  /** ID of the linked task (target of the link from this task). */
  taskId: string;
  /** Relationship direction: this task --[type]--> taskId. */
  type: TaskLinkType;
}

export interface TaskCommit {
  sha: string;
  message: string;
  timestamp: string;
  /**
   * Original git AUTHOR email of the commit (not committer, not mailmap).
   * Optional and additive: written only by `vibeflow authors link`; absent
   * means "not linked yet" — never written as null or "".
   */
  authorEmail?: string;
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
  /**
   * Git user.email captured at comment-creation time for human-authored
   * CLI comments. The `author` field stays the actor text (user/agent/…);
   * this is the machine-checkable attribution alongside it. Absent means
   * "unknown" — never written as null or "".
   */
  authorEmail?: string;
}

export interface TaskFileRef {
  name: string;
  addedAt: string;
  linkedPath?: string;
  mimeType?: string;
  /** True when written by the engine (verify evidence, baselines). Absent/false = user upload. Stamped at write time; read paths must never infer it from the name. */
  system?: boolean;
}

// ── Task system (.proto/tasks/{id}.json) ───────────────────────────────────

/** Returns true if the value is a valid TaskStatus. */
export function isTaskStatus(v: unknown): v is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(v as string);
}

/**
 * Email-ish validation for the optional `authorEmail` attribution field on
 * task, commit, and comment records. Deliberately permissive — the field is
 * attribution metadata, never an address we deliver to — but it must reject
 * empty/whitespace strings and anything without a `local@domain.tld` shape,
 * so a malformed capture can never be persisted in the place the lossless
 * mirror treats as authoritative.
 *
 * Validated at the WRITE sites (`vibeflow authors link`, comment capture).
 * On READ, any non-empty string passes through untouched: rewriting or
 * dropping an existing value would violate the mirror rule (the local record
 * is the source; only writers may refuse to set, never readers to keep).
 */
export function isValidAuthorEmail(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 320 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)
  );
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
  /** Git username of the task author. Display-only; never rewritten. */
  author?: string;
  /**
   * Author email for the task as a whole. Optional and additive — NEVER
   * inferred from commits[]; only set deliberately (e.g. a maintenance
   * backfill). Absent means "not attributed"; writers must keep it missing
   * rather than write null or "".
   */
  authorEmail?: string;
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
  /** Links to other tasks (parent, relates, blocks). Child stores {taskId: parentId, type: 'parent'}. */
  links?: TaskLink[];
  /** User IDs/emails who have opened this task (persistent read state). */
  openedBy?: string[];
  /** User IDs/emails who expanded this card's children inline (persistent UI state). */
  expandedBy?: string[];
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
  /**
   * Kanban dev mode (ticket 7e85c338): serve the on-disk kanban bundle as a
   * separate no-store asset + live-reload on rebuild, instead of the
   * production inlined megastring. EXPLICIT opt-in only (`--dev` CLI flag);
   * `VIBEFLOW_DEV=1` also enables it. Never default — production stays a
   * single inlined file that works from npx with no losable assets.
   */
  dev?: boolean;
  /** When true, suppress the "Press Ctrl+C to stop" hint from server startup output (caller will print it). */
  noCtrlCHint?: boolean;
  /**
   * When true, `serve()` prints NOTHING — no banner, no guide, no Ctrl+C hint.
   *
   * For programmatic callers only. Under the MCP stdio transport stdout IS the
   * JSON-RPC channel, so the startup guide would corrupt the protocol stream
   * (same hazard as `announceProjectRoot` in src/index.ts). A quiet caller
   * reads the guide from `ServeInstance.guide` instead.
   *
   * The human CLI path leaves this unset and its output is byte-identical to
   * the pre-extraction inline `console.log` blocks.
   */
  quiet?: boolean;
  /** @internal Testing only: inject a principal resolver for the /api/v0 read alias (undefined = trusted local principal). */
  _testResolvePrincipal?: (req: {
    headers: Record<string, unknown>;
  }) => Principal;
}
