// Brand icon — single source of truth (import from here everywhere)
export { VibeflowIcon } from "./VibeflowIcon";

// Shared kanban components
export { KanbanBoard } from "./KanbanBoard";
export { KanbanCard } from "./KanbanCard";
export { TaskDetailPanel } from "./TaskDetailPanel";
export type { TaskComment, TaskDetailPanelHandlers, StatusConfig, TaskPriority } from "./TaskDetailPanel";
export { StatusBadge } from "./StatusBadge";
export { TypeBadge } from "./TypeBadge";
export { PriorityBadge } from "./PriorityBadge";

// Task type data (TypePicker is re-exported via export * from "./kanban" to avoid duplicate __source)
export {
  TASK_TYPES,
  TASK_TYPE_VALUES,
  TASK_TYPE_ICONS,
  TASK_TYPE_CSS,
  TASK_TYPE_COLORS,
  getTaskTypeIcon,
  getTaskTypeCss,
  getTaskTypeColor,
} from "./task-types";
export type { TaskType } from "./task-types";

// Shared content components (AutoExpandTextarea, MarkdownPreview, TypePicker, renderMarkdown
// are re-exported via export * from "./kanban" below to avoid Turbopack duplicate __source errors)

export type {
  KanbanTask,
  KanbanColumn,
  KanbanHandlers,
} from "./types";

// Realtime collaboration client — shared across surfaces. The transport is
// injected, so single-user surfaces use it with `enabled: false`.
export {
  createSocket,
  useCollab,
  REALTIME_PATH,
  SERVER_EVENT,
} from "./socket";
export type {
  CollabEvent,
  CollabSocket,
  CreateSocketOptions,
  CreateTransport,
  RealtimeSocket,
  TransportOptions,
  UseCollabOptions,
  UseCollabResult,
} from "./socket";

// Kanban app components (shared between CLI and web)
export * from "./kanban";

