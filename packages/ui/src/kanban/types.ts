export type { TaskType } from '../task-types';
import type { TaskType } from '../task-types';

export type TaskStatus = 'backlog' | 'todo' | 'in-progress' | 'review' | 'done';
export type Priority = 'Critical' | 'High' | 'Medium' | 'Low';

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
}

export interface Comment {
  id: string;
  author: string;
  authorName?: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  /** 'system' = auto-generated trace entry; 'comment' (default) = normal message. */
  type?: 'comment' | 'system';
  /** True when a comment was soft-deleted — its text is replaced by a placeholder. */
  deleted?: boolean;
  /** True when the current user is the author of this comment (enables edit/delete UI). */
  isOwnComment?: boolean;
  /** Origin platform of this comment or activity: 'cli' = from CLI command (likely agent), 'web' = from web app. */
  source?: 'cli' | 'web';
}

export interface FileEntry {
  name: string;
  url: string;
  size?: number;
  linkedPath?: string;
  mimeType?: string;
  taskId?: string;
  createdAt?: string;
}

export type LiveActivityState = 'viewing' | 'editing' | 'locked';

export interface LiveActivity {
  taskId: string;
  user: string;
  /** Raw user ID from the WS event — used for reliable presence.leave matching. */
  userId?: string;
  state: LiveActivityState;
}

export interface Column {
  id: TaskStatus;
  label: string;
  color: string;
  accent: string;
  glow?: boolean;
}

export type AgentStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export interface AgentRun {
  taskId: string;
  taskTitle: string;
  status: AgentStatus;
  model?: string;
  worktree?: string;
  branch?: string;
  startedAt?: string;
  completedAt?: string;
  logs: string[];
  /** Session metadata captured from opencode JSON output */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  durationMs?: number;
}

export interface PanelState {
  open: boolean;
  task: Task | null;
  tab: 'details' | 'comments' | 'files' | 'agent';
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

export type ViewMode = 'board' | 'list';

export interface AppSettings {
  visibleCols?: TaskStatus[];
  viewMode?: ViewMode;
  panelWidth?: number;
  autoCommit?: boolean;
  autoComment?: boolean;
  autoPush?: boolean;
  createBranch?: boolean;
  /** Default model for agent runs (overall fallback) */
  defaultModel?: string;
  /** Default agent for agent runs (fallback when task has no agent set) */
  defaultAgent?: string;
  /** When true, use per-type default models instead of the overall default */
  perTypeModels?: boolean;
  /** Default model for Bug tasks */
  defaultModelBug?: string;
  /** Default model for Research tasks */
  defaultModelResearch?: string;
  /** Default model for Task tasks */
  defaultModelTask?: string;
  /** When true, show agent-related UI features (experimental) */
  experimentalAgents?: boolean;
}

/** Abstract API interface for kanban operations – implemented differently by CLI (fetch) and web (tRPC). */
export interface KanbanApi {
  getTasks(): Promise<{ tasks: Task[] }>;
  createTask(data: Partial<Task>): Promise<{ success: boolean; task?: Task }>;
  updateTask(id: string, data: Partial<Task>): Promise<{ success: boolean; task?: Task }>;
  deleteTask(id: string): Promise<void>;
  getComments(taskId: string): Promise<{ comments: Comment[] }>;
  addComment(taskId: string, text: string): Promise<void>;
  updateComment(taskId: string, commentId: string, text: string): Promise<void>;
  deleteComment(taskId: string, commentId: string): Promise<void>;
  getFiles(taskId: string): Promise<{ files: FileEntry[] }>;
  uploadFile(taskId: string, file: File): Promise<void>;
  deleteFile(taskId: string, filename: string): Promise<void>;
  getProject(): Promise<{ name?: string; gitUserName?: string; branch?: string | null }>;
  getCopilotStatus(): Promise<{ authenticated: boolean; username?: string }>;
  copilotLogin(): Promise<{ launched?: boolean }>;
  getSettings(): Promise<Record<string, unknown>>;
  saveSettings(settings: Record<string, unknown>): Promise<void>;
  /** Optional WebSocket URL for real-time updates (CLI only). */
  wsUrl?(): string;
  /** Get available models from OpenCode CLI */
  getModels?(): Promise<{ models: { id: string; label: string; provider: string; recommended?: boolean }[]; error: string | null }>;
  /** Get available agents from OpenCode CLI */
  getAgents?(): Promise<{ agents: { id: string; name: string; scope: string }[]; error: string | null }>;
}
