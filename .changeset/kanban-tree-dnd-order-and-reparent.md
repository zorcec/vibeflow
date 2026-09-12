---
"@vibeflow-tools/cli": patch
---

Kanban tree drag & drop reliability: sibling reordering now persists the intended order, and a child nested under another child can be dragged back to the root parent.

- Reordering siblings computed a `sortKey` around neighbours that had never been reordered, but only the dragged task's key was written. Sibling order falls back to timestamps when a task has no `sortKey`, so the drag appeared to do nothing (or landed in the wrong slot). The reorder/reparent drop now uses the shared `computeTreeReorder` plan and persists its normalization patches too.
- Dropping an already-parented task on a card centre or a card's children zone was rejected by the single-parent rule, so a grandchild could not be moved back to its root/ancestor parent. Those drops now reparent the task instead of doing nothing.
