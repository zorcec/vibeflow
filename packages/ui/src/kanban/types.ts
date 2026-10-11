export type { TaskType } from "../task-types";
import type { TaskType } from "../task-types";

export type TaskStatus = "backlog" | "todo" | "in-progress" | "review" | "done";
export type Priority = "Critical" | "High" | "Medium" | "Low";

// ── Task links (mirrors CLI types.ts) ──────────────────────────────────
export const TASK_LINK_TYPES = ["parent", "relates", "blocks"] as const;
export type TaskLinkType = (typeof TASK_LINK_TYPES)[number];

export interface TaskLink {
  taskId: string;
  type: TaskLinkType;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  type?: TaskType;
  priority?: Priority;
  agent?: string;
  model?: string;
  selector?: string;
  cssSelector?: string;
  file?: string;
  line?: number;
  col?: number;
  component?: string;
  url?: string;
  reportBack?: boolean;
  commit?: string;
  commits?: { sha: string; message: string; timestamp: string }[];
  commitPushed?: boolean | null;
  commentCount?: number;
  fileCount?: number;
  files?: Array<{
    name: string;
    linkedPath?: string;
    addedAt?: string;
  }>;
  createdAt?: string;
  updatedAt?: string;
  authorName?: string;
  author?: string;
  assigneeName?: string;
  annotatedElementText?: string;
  sortKey?: string;
  /** Free-form tags for categorization and filtering. */
  tags?: string[];
  /** Git branch name created for this task (when createBranch setting is ON). */
  branchName?: string;
  /** When true, the task was successfully verified. */
  verified?: boolean;
  /** Links to other tasks (parent, relates, blocks). */
  links?: TaskLink[];
  /** User IDs who have opened this task (persistent read state). */
  openedBy?: string[];
  /** User IDs who expanded this card's children inline (persistent UI state). */
  expandedBy?: string[];
}

export interface Comment {
  id: string;
  author: string;
  authorName?: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  /** 'system' = auto-generated trace entry; 'comment' (default) = normal message. */
  type?: "comment" | "system";
  /** True when a comment was soft-deleted — its text is replaced by a placeholder. */
  deleted?: boolean;
  /** True when the current user is the author of this comment (enables edit/delete UI). */
  isOwnComment?: boolean;
  /** Origin platform of this comment or activity: 'cli' = from CLI command (likely agent), 'web' = from web app. */
  source?: "cli" | "web";
}

export interface FileEntry {
  name: string;
  url: string;
  size?: number;
  linkedPath?: string;
  mimeType?: string;
  taskId?: string;
  createdAt?: string;
  /** True when written by the engine. Set by the server flag; never inferred from the name. */
  system?: boolean;
}

export type LiveActivityState = "viewing" | "editing";

/**
 * Which part of a task a present user is in. Mirrors `PresenceArea` in
 * `@vibeflow-tools/shared` (kept local so the kanban UI never imports
 * the wire contract for rendering).
 */
export type PresenceArea =
  | "description"
  | "comments"
  | "files"
  | "relations"
  | "header";

export interface LiveActivity {
  taskId: string;
  user: string;
  /** Raw user ID from the WS event — used for reliable presence.leave matching. */
  userId?: string;
  state: LiveActivityState;
  /** Area of the task the user is in; null = task-level (no area focused). */
  area?: PresenceArea | null;
}

/** One peer present in a task, for the detail-panel presence line. */
export interface PresenceEntry {
  user: string;
  /** Raw user ID — lets the panel exclude the current user reliably. */
  userId?: string;
  /** Area the peer is in; null = task-level. */
  area: PresenceArea | null;
}

/**
 * One remote peer's cursor/selection inside the shared description doc.
 * Plain text offsets — deliberately Yjs-free so the shared UI (and the CLI
 * bundle) never imports the CRDT layer; only the web doc binding produces
 * these from awareness states.
 */
export interface DescriptionSelection {
  /** Stable per-peer key (awareness client id as a string). */
  key: string;
  name: string;
  color: string;
  /** Caret offset when equal to `head`; otherwise the selection anchor. */
  anchor: number;
  head: number;
}

/**
 * Live binding between the description editor and the shared Y.Doc.
 * While present, the doc is the single writer: the editor displays
 * `text`, routes every keystroke through `onEdit`, and the whole-value
 * description save is retired (title still saves through `onPatch`).
 */
export interface DescriptionDocBinding {
  /** Current merged doc text — the textarea's single source of truth. */
  text: string;
  /** Local edit → spliced into the Y.Text (never a whole-value save). */
  onEdit: (next: string) => void;
  /** Local caret/selection movement → throttled cursor broadcast. */
  onSelection: (anchor: number, head: number) => void;
  /** Remote peers' cursors/selections in doc coordinates. */
  selections: DescriptionSelection[];
}

export interface Column {
  id: TaskStatus;
  label: string;
  color: string;
  accent: string;
  glow?: boolean;
}

export interface PanelState {
  open: boolean;
  task: Task | null;
  tab: "details" | "comments" | "files";
  addColumnId?: TaskStatus;
}

export interface TaskModalState {
  open: boolean;
  task: Task | null;
  addColumnId?: TaskStatus;
}

export interface FilePreviewState {
  open: boolean;
  name: string;
  url: string;
}

export type ViewMode = "board" | "compact" | "list";

export interface AppSettings {
  visibleCols?: TaskStatus[];
  viewMode?: ViewMode;
  panelWidth?: number;
  /** Global preference: open the task detail panel fullscreen on both surfaces. */
  panelFullscreen?: boolean;
  autoCommit?: boolean;
  autoComment?: boolean;
  autoPush?: boolean;
  createBranch?: boolean;
  requireVerifyBeforeReview?: boolean;
}

/** Abstract API interface for kanban operations – implemented differently by CLI (fetch) and web (tRPC). */
export interface KanbanApi {
  getTasks(): Promise<{ tasks: Task[] }>;
  createTask(data: Partial<Task>): Promise<{ success: boolean; task?: Task }>;
  updateTask(
    id: string,
    data: Partial<Task>,
  ): Promise<{ success: boolean; task?: Task }>;
  deleteTask(
    id: string,
    unlinkChildren?: boolean,
    deleteChildren?: boolean,
  ): Promise<void>;
  detachTask(id: string, deleteChildren?: boolean): Promise<void>;
  getComments(taskId: string): Promise<{ comments: Comment[] }>;
  addComment(taskId: string, text: string): Promise<void>;
  updateComment(taskId: string, commentId: string, text: string): Promise<void>;
  deleteComment(taskId: string, commentId: string): Promise<void>;
  getFiles(taskId: string): Promise<{ files: FileEntry[] }>;
  uploadFile(taskId: string, file: File): Promise<void>;
  deleteFile(taskId: string, filename: string): Promise<void>;
  getProject(): Promise<{
    name?: string;
    gitUserName?: string;
    branch?: string | null;
  }>;
  getSettings(): Promise<Record<string, unknown>>;
  saveSettings(settings: Record<string, unknown>): Promise<void>;
  /** Optional WebSocket URL for real-time updates (CLI only). */
  wsUrl?(): string;
}
