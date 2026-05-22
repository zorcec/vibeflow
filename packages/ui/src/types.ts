// Generic types for the shared UI kanban components.
// Keep these minimal so both CLI (local) and web (SaaS) can use them.

export interface KanbanTask {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  type?: string | null;
  priority?: string | null;
  assigneeId?: string | null;
  commentCount?: number;
  fileCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface KanbanColumn {
  id: string;
  label: string;
  /** CSS color value (var(--p-*) or hex) */
  color: string;
  accent?: string;
}

export interface KanbanHandlers {
  onCreate: (status: string, title: string) => Promise<void> | void;
  onUpdate: (id: string, patch: Partial<KanbanTask>) => Promise<void> | void;
  onDelete?: (id: string) => Promise<void> | void;
  onCardClick?: (task: KanbanTask) => void;
}

// Legacy task types – kept for backwards compatibility.
export interface TaskItem {
  id: string;
  title: string;
  description: string | null;
  status: "todo" | "in_progress" | "done" | "cancelled";
  assigneeId: string | null;
  createdAt: string; // ISO string
}

export interface BoardItem {
  id: string;
  name: string;
  tasks: TaskItem[];
}

export interface ProjectItem {
  id: string;
  name: string;
  boards: BoardItem[];
}

export interface BoardHandlers {
  onTaskCreate: (boardId: string, title: string) => Promise<void>;
  onTaskUpdate: (taskId: string, patch: Partial<TaskItem>) => Promise<void>;
  onTaskDelete: (taskId: string) => Promise<void>;
}
