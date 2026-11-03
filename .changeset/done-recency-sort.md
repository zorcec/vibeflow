---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

Done lane/group now sorts most-recently-modified first: the board done column and the list-view done group order by `updatedAt` desc (falling back to `createdAt`), ignoring manual drag `sortKey` order. Other lanes keep their existing order; no pagination or cap change.
