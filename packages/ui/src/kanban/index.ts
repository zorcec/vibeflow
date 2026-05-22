// Kanban shared types
export type {
  TaskType,
  Task,
  TaskStatus,
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
  AgentStatus,
  AgentRun,
} from './types';

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
} from './utils';
export type { ReorderPatch, ReorderResult } from './utils';

// Kanban components
export { KanbanBoard, COLUMNS } from './components/KanbanBoard';
export { KanbanListView } from './components/KanbanListView';
export { Header as KanbanHeader } from './components/Header';
export { DetailPanel } from './components/DetailPanel';
export { TaskCard as KanbanTaskCard, resolveTaskCardBorderColor } from './components/TaskCard';
export { FilterBar } from './components/FilterBar';
export type { FilterState } from './components/FilterBar';
export { SettingsModal } from './components/SettingsModal';
export { ConfirmModal } from './components/ConfirmModal';
export { FilePreviewModal } from './components/FilePreviewModal';
export { ModalBase } from './components/ModalBase';
export { AgentTab } from './components/AgentTab';
export { AgentQueuePanel } from './components/AgentQueuePanel';

// Shared sub-components
export { HeaderActionButton } from './components/shared/HeaderActionButton';
export { TaskDetailsTab } from './components/shared/TaskDetailsTab';
export { CommentsList } from './components/shared/CommentsList';
export { CommentsInputArea } from './components/shared/CommentsInputArea';
export { FilesList } from './components/shared/FilesList';
export { MarkdownEditableField } from './components/shared/MarkdownEditableField';
export { AutoExpandTextarea } from './components/shared/AutoExpandTextarea';
export { MarkdownPreview } from './components/shared/MarkdownPreview';
export { TypePicker } from './components/shared/TypePicker';
export { TagPills } from './components/shared/TagPills';
export { TagInput } from './components/shared/TagInput';
export { getTagColors } from './tag-colors';
