---
"@vibeflow-tools/cli": patch
---

Kanban: a task with a parent is now rendered in the column matching its own status, not only inside its parent's card.

Columns were rendered from the root tasks of the store, so a parented task appeared only as a child row inside its root's card — in whatever column the root's status put it — and was invisible in the column matching its own status. The CLI filters on the task's own status, so it was handing out work the board concealed. Columns (and the list view's status groups) are now a view of status; the children tree inside a parent's card remains the view of the relation.
