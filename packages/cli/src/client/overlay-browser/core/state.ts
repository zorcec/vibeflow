import type { Task } from './types.js';

// Shared mutable state for the entire overlay runtime.
export const state = {
  tasks: [] as Task[],
  theme: 'dark' as 'dark',
  annotationMode: false,
  sidebar: null as HTMLElement | null,
  popover: null as HTMLElement | null,
  contextMenu: null as HTMLElement | null,
  editModal: null as HTMLElement | null,
  sidebarPinned: false,
  activeTooltip: null as HTMLElement | null,
  indicatorRafId: null as number | null,
  indicatorsVisible: false,
  sidebarShowDone: true,
  showAllPages: false,
  tooltipPinned: false,
  hoverTarget: null as Element | null,
  annotateHighlightTarget: null as Element | null,
  currentHref: '',
  host: null as HTMLElement | null,
  root: null as ShadowRoot | null,
  status: null as HTMLElement | null,
  indicatorContainer: null as HTMLElement | null,
  edgeTrigger: null as HTMLElement | null,
  pageSwitcher: null as HTMLElement | null,
  pages: [] as string[],

  // WS
  ws: null as WebSocket | null,
  reconnectAttempt: 0,
  reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  pingInterval: null as ReturnType<typeof setInterval> | null,

  // Project info (fetched from /api/project on connect)
  projectName: null as string | null,

  // Session-only flag — set by "Disable Vibeflow" to suppress all overlay
  // activity for the rest of the page session (resets on page refresh).
  disabled: false,

  // Callbacks registered by index.ts (avoids circular module deps)
  onTasksFetched: null as ((tasks: Task[]) => void) | null,
  onTasksUpdatedMessage: null as (() => void) | null,
};

export const PREFS_KEY = 'vibeflow-studio-prefs';

export const RECONNECT_BASE = 1000;
export const RECONNECT_MAX = 30000;
export const PING_INTERVAL = 25000;

export const HOVER_CLASS = 'vibeflow-hover-highlight';
export const ANNOTATE_HIGHLIGHT_CLASS = 'vibeflow-annotate-highlight';
