// Kanban shared types
export type {
  TaskType,
  Task,
  TaskStatus,
  TaskLink,
  Priority,
  Comment,
  FileEntry,
  Column,
  PanelState,
  TaskModalState,
  FilePreviewState,
  ViewMode,
  AppSettings,
  KanbanApi,
  LiveActivity,
  LiveActivityState,
} from "./types";

// Kanban shared utilities
export {
  renderMarkdown,
  isNewComments,
  markCommentsSeen,
  formatFileSize,
  formatDate,
  generateSortKeyBetween,
  initialSortKeys,
  compareTaskOrder,
  computeReorder,
  maxSortKey,
  computeBackfillPlan, // one-time sortKey backfill planner (see docs/plans/sortkey-fix.md)
} from "./utils";
export type { ReorderPatch, ReorderResult, BackfillTask } from "./utils";

// Kanban components
export { KanbanBoard, COLUMNS } from "./components/KanbanBoard";
export { KanbanListView } from "./components/KanbanListView";
export { Header as KanbanHeader } from "./components/Header";
export { DetailPanel } from "./components/DetailPanel";
export {
  TaskCard as KanbanTaskCard,
  resolveTaskCardBorderColor,
} from "./components/TaskCard";
export { FilterBar } from "./components/FilterBar";
export type { FilterState } from "./components/FilterBar";
export { SettingsModal } from "./components/SettingsModal";
export { ConfirmModal } from "./components/ConfirmModal";
export {
  DeleteConfirmDialog,
  type DeleteChildrenMode,
} from "./components/DeleteConfirmDialog";
export { FilePreviewModal } from "./components/FilePreviewModal";
export { ModalBase } from "./components/ModalBase";

// Shared sub-components
export { HeaderActionButton } from "./components/shared/HeaderActionButton";
export { TaskDetailsTab } from "./components/shared/TaskDetailsTab";
export { CommentsList } from "./components/shared/CommentsList";
export { CommentsInputArea } from "./components/shared/CommentsInputArea";
export { FilesList } from "./components/shared/FilesList";
export { MarkdownEditableField } from "./components/shared/MarkdownEditableField";
export { AutoExpandTextarea } from "./components/shared/AutoExpandTextarea";
export { MarkdownPreview } from "./components/shared/MarkdownPreview";
export { TypePicker } from "./components/shared/TypePicker";
export { TagPills } from "./components/shared/TagPills";
export { TagInput } from "./components/shared/TagInput";
export { getTagColors } from "./tag-colors";

export {
  RecursiveChildrenTree,
  MAX_TREE_DEPTH,
  TREE_INDENT_PX,
} from "./components/RecursiveChildrenTree";

export { ChildRow } from "./components/ChildRow";

export {
  STATUS_COLORS,
  getStatusColor,
  groupDetailRelations,
  classifyDropZone,
  classifyForDropIntent,
  classifyTreeRowIntent,
  canReparent,
  canDropAsChild,
  computeTreeReorder,
  dragSession,
  getDescendants,
  DROP_BAND_RATIO,
  DROP_BAND_MIN_PX,
  DROP_BAND_MAX_PX,
} from "./task-links";
export type {
  DetailRelationRow,
  DetailRelationsGroups,
  DropIntent,
  DropIntentKind,
  TreeReorderPlan,
} from "./task-links";

// Theme resolver + persistence (shared by every kanban consumer)
export {
  THEMES,
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  isTheme,
  getStoredTheme,
  setStoredTheme,
  clearStoredTheme,
  resolveInitialTheme,
  applyTheme,
  applyInitialTheme,
} from "./theme";
export type { Theme } from "./theme";
