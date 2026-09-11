---
"@vibeflow-tools/cli": patch
---

Cascade done status to descendants: when a parent task is moved to done, all children and grandchildren are also marked done. Server-side authoritative cascade in PATCH handler + client-side optimistic update in kanban drag-drop.
