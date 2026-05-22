// Re-export from shared module — single source of truth for task type metadata.
export { TASK_TYPE_ICONS, getTaskTypeIcon } from '../shared/task-types.js';
export { TASK_TYPES as TASK_TYPE_CHOICES_DETAILED } from '../shared/task-types.js';
import { TASK_TYPE_VALUES } from '../shared/task-types.js';

export const TASK_TYPE_CHOICES = TASK_TYPE_VALUES;
