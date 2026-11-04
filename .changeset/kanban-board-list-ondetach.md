---
"@vibeflow-tools/ui": patch
---

Kanban board and list view forward `onDetach` into their unlink surfaces. `KanbanBoard` accepts an optional `onDetach` and passes it through the column into each card's inline children tree, so the tree's Unlink button calls back with the child id instead of never rendering. `KanbanListView` accepts the same prop and shows a hover Unlink action on rows that still carry a parent link (search/filter orphans). Both props are optional — existing consumers render byte-identically without them.
