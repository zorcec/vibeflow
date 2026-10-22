// Single source of truth for task type metadata — shared between CLI and SaaS.
export const TASK_TYPES = [
  { value: 'Task',     icon: '☑',  label: 'Task',     css: 'type-task',     tooltip: 'A general task or feature to implement.' },
  { value: 'Bug',      icon: '🐞', label: 'Bug',      css: 'type-bug',      tooltip: 'A defect — annotator collects page errors and console logs to help reproduce it.' },
  { value: 'Research', icon: '🔬', label: 'Research', css: 'type-research', tooltip: 'A research task — agent will NOT write code but must attach a findings report.' },
] as const;

export type TaskType = (typeof TASK_TYPES)[number]['value'];

// SAFETY: `TASK_TYPES` is `as const` with `value` fields typed as the three
// literals, so mapping to `value` provably yields exactly the TaskType union;
// the assertion only recovers the tuple element type that `.map` widens.
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

// ── Filter vocabulary (ticket zbew735s) ────────────────────────────────────
// The product has exactly three task types — Bug, Task, Research. The board
// type filter offers exactly these three, from the ONE constant below (never
// a literal in the component), with a friendly label per type.
//
// Legacy values (Feature, Enhancement — accepted by older CLIs and still
// present in stored data, e.g. `tasks --type Feature`) are NOT filter
// options, but tasks carrying them must stay findable: `canonicalTaskType`
// maps each legacy value onto its canonical type, so those tasks appear
// under that type's filter instead of being silently hidden. The map lives
// here and only here — change the mapping in `LEGACY_TASK_TYPE_MAP`, never
// at a call site.
export const TASK_TYPE_FILTER_OPTIONS: ReadonlyArray<{
  value: TaskType;
  label: string;
}> = [
  { value: 'Bug', label: 'Bug' },
  { value: 'Task', label: 'Task' },
  { value: 'Research', label: 'Research' },
];

/** Legacy stored type value → canonical filter type. */
export const LEGACY_TASK_TYPE_MAP: Record<string, TaskType> = {
  // Both were "build the feature" work before the vocabulary shrank to
  // three: a Feature/Enhancement task IS a Task for filtering purposes.
  Feature: 'Task',
  Enhancement: 'Task',
};

/**
 * Map any stored `type` value onto its canonical filter type (ticket
 * zbew735s). Canonical values (any casing) return in canonical casing;
 * legacy values return their `LEGACY_TASK_TYPE_MAP` target; a missing or
 * blank type reads as 'Task' (the same default the CLI `tasks --type`
 * listing applies). A genuinely unknown label (e.g. a deliberately written
 * `Chore`) survives verbatim — it stays visible under "All types" and
 * simply has no dedicated filter option.
 */
export function canonicalTaskType(value?: string | null): string {
  const raw = (value ?? '').trim();
  if (raw === '') return 'Task';
  const lower = raw.toLowerCase();
  for (const opt of TASK_TYPE_FILTER_OPTIONS) {
    if (opt.value.toLowerCase() === lower) return opt.value;
  }
  for (const [legacy, canonical] of Object.entries(LEGACY_TASK_TYPE_MAP)) {
    if (legacy.toLowerCase() === lower) return canonical;
  }
  return raw;
}

/**
 * Type-filter predicate (ticket zbew735s): a task matches the active filter
 * when its CANONICAL type equals the filter, so tasks stored under a legacy
 * alias (Feature/Enhancement → Task) are returned by their canonical
 * type's filter. A null filter matches everything.
 */
export function matchesTaskTypeFilter(
  taskType: string | null | undefined,
  filter: TaskType | null,
): boolean {
  if (filter === null) return true;
  return canonicalTaskType(taskType) === filter;
}

export function getTaskTypeIcon(type?: string | null): string {
  return TASK_TYPE_ICONS[type ?? 'Task'] ?? '☑';
}

export function getTaskTypeCss(type?: string | null): string {
  return TASK_TYPE_CSS[type ?? 'Task'] ?? 'type-task';
}

export function getTaskTypeColor(type?: string | null): string {
  return TASK_TYPE_COLORS[type ?? 'Task'] ?? TASK_TYPE_COLORS['Task']!;
}
