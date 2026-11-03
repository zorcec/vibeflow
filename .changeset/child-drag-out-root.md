---
"@vibeflow-tools/cli": patch
---

Kanban: dropping a child row onto another lane's card edge now moves it there as a root item (parent link unlinked plus status/sortKey moved), matching the column-background drop. Previously the reorder path persisted only status/sortKey, so the card appeared in the new lane while staying attached to the old parent's tree. List-view section drops use the same drag-out path.
