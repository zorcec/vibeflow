---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

Board type filter offers exactly the canonical three (ticket zbew735s): Bug, Task, Research come from the one exported `TASK_TYPE_FILTER_OPTIONS` constant with a friendly label per type, instead of whatever values appear in the data. Legacy stored values map onto their canonical type in `LEGACY_TASK_TYPE_MAP` (Feature and Enhancement are Task) via `canonicalTaskType` / `matchesTaskTypeFilter`, so tasks stored under a legacy alias still appear under their canonical type's filter instead of being silently hidden. The CLI kanban board matches on the canonical type too.
