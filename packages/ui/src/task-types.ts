// Single source of truth for task type metadata — shared between CLI and SaaS.
export const TASK_TYPES = [
  { value: 'Task',     icon: '☑',  label: 'Task',     css: 'type-task',     tooltip: 'A general task or feature to implement.' },
  { value: 'Bug',      icon: '🐞', label: 'Bug',      css: 'type-bug',      tooltip: 'A defect — annotator collects page errors and console logs to help reproduce it.' },
  { value: 'Research', icon: '🔬', label: 'Research', css: 'type-research', tooltip: 'A research task — agent will NOT write code but must attach a findings report.' },
] as const;

export type TaskType = (typeof TASK_TYPES)[number]['value'];

export const TASK_TYPE_VALUES = TASK_TYPES.map((t) => t.value) as unknown as readonly TaskType[];

export const TASK_TYPE_ICONS: Record<string, string> = Object.fromEntries(
  TASK_TYPES.map((t) => [t.value, t.icon]),
);

export const TASK_TYPE_CSS: Record<string, string> = Object.fromEntries(
  TASK_TYPES.map((t) => [t.value, t.css]),
);

export const TASK_TYPE_COLORS: Record<string, string> = {
  Task:     '#94a3b8',
  Bug:      '#ef4444',
  Research: '#a855f7',
};

export function getTaskTypeIcon(type?: string | null): string {
  return TASK_TYPE_ICONS[type ?? 'Task'] ?? '☑';
}

export function getTaskTypeCss(type?: string | null): string {
  return TASK_TYPE_CSS[type ?? 'Task'] ?? 'type-task';
}

export function getTaskTypeColor(type?: string | null): string {
  return TASK_TYPE_COLORS[type ?? 'Task'] ?? TASK_TYPE_COLORS['Task']!;
}
