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
  PresenceArea,
  PresenceEntry,
  DescriptionSelection,
  DescriptionDocBinding,
} from "./types";

// Kanban shared utilities
export {
  mergeTaskFromPayload,
} from "./task-merge";
export {
  taskMatchesQuery,
  filterTasksByQuery,
  SEARCH_DEBOUNCE_MS,
} from "./search";
export type { SearchableTask } from "./search";
export { useDebouncedValue } from "./useDebouncedValue";
export {
  MINIMAL_FIELDS,
  verifyLabel,
  verifyFoldedIntoStatusMove,
  tagSetKey,
  normalizeTagList,
  parseTagKey,
  diffTagLists,
  resolveTagChange,
  formatTagChange,
  linkSetKey,
  diffTaskFields,
} from "./fieldChanges";
export type { FieldChange } from "./fieldChanges";
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

// Shared image-ingest transform (browser-safe core, zero deps).
export {
  MAX_INGEST_WIDTH,
  LOSSY_WEBP_QUALITY,
  classifyImageUpload,
  decideImageTransform,
  withTrueExtension,
  buildPasteFilename,
  extensionForMime,
  stripJpegMetadata,
  hasBrowserImagePipeline,
  transformRgbaUpload,
  transformImageForUpload,
} from "./imageTransform";
export type {
  ImageKind,
  ImageTransformBranch,
  ImageTransformDecision,
  TransformedUpload,
} from "./imageTransform";
export {
  configureImageCodecs,
  configureWasmBaseUrl,
  encodeLosslessWebp,
  encodeLossyWebp,
  decodeWebp,
  resizeRgbaToWidth,
} from "./imageCodecs";
export type {
  RgbaImage,
  WasmAssetName,
  WasmBytesLoader,
} from "./imageCodecs";

// Kanban components
export { KanbanBoard, COLUMNS } from "./components/KanbanBoard";
export { KanbanListView } from "./components/KanbanListView";
export { Header as KanbanHeader } from "./components/Header";
export { DetailPanel } from "./components/DetailPanel";
export {
  TaskCard as KanbanTaskCard,
  StatusDot,
  resolveTaskCardBorderColor,
  nextLaneStatus,
  nextLaneLabel,
} from "./components/TaskCard";
export { FilterBar } from "./components/FilterBar";
export type { FilterState } from "./components/FilterBar";
export { SettingsModal } from "./components/SettingsModal";
export type { AppearanceSlotHandle } from "./components/SettingsModal";
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
export type { TaskHoverInfo } from "../MarkdownPreview";
export { TypePicker } from "./components/shared/TypePicker";
// Canonical type-filter vocabulary (ticket zbew735s) — the filter offers the
// three options from this ONE constant; legacy aliases map via
// `canonicalTaskType` / `matchesTaskTypeFilter` so old values stay findable.
export {
  TASK_TYPE_FILTER_OPTIONS,
  LEGACY_TASK_TYPE_MAP,
  canonicalTaskType,
  matchesTaskTypeFilter,
} from "../task-types";
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
  STATUS_LABELS,
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
  DROP_BAND_MIN_CENTRE_PX,
  TREE_DROP_BAND_MIN_CENTRE_PX,
} from "./task-links";
export type {
  DetailRelationRow,
  DetailRelationsGroups,
  DropIntent,
  DropIntentKind,
  TreeReorderPlan,
} from "./task-links";

// Theme registry + resolver + persistence (shared by every kanban consumer)
export {
  THEME_REGISTRY,
  THEMES,
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  getThemeDefinition,
  isTheme,
  getStoredTheme,
  setStoredTheme,
  clearStoredTheme,
  resolveInitialTheme,
  applyTheme,
  applyInitialTheme,
} from "./theme";
export type { Theme, ThemeDefinition, ThemeBase } from "./theme";
