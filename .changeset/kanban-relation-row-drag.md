---
"@vibeflow-tools/cli": patch
---

Kanban task-details Relations area: PARENTS / BLOCKS / RELATED rows are draggable again.

`RecursiveChildrenTree` wired a row's drag source through the same `dndActive` flag that decides whether the tree accepts drop intents. The flat relation groups in the detail panel deliberately pass no drop intent, so their rows silently lost the drag source too: no `draggable`, no `dragSession` entry, and a drag started from them could never resolve a target. A rendered row always represents a task, so it is now always a drag source; drop-intent handling stays exclusive to the CHILDREN tree. Task `9cd3f4bb` was the only task in the store whose sole relation is `related`, so it was the one where every relation row was inert.
