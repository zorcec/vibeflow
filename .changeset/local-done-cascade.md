---
"@vibeflow-tools/cli": minor
---

Local mode: marking a parent task `done` now cascades `done` to all descendants (children and grandchildren) in the same edit. Already-done descendants are left untouched, cycles terminate, and a child set to `done` never touches its parent. Descendant lookup reads a `parentId → [childId]` sidecar index under `.vibeflow-state/` (rebuilt from one scan when missing, stale, or corrupt) so done-edits stay O(1) on large stores. NOTE for ticket 4efaa878 (clone-mode removal): the invalidation hook in clone.ts exists only because clone writes task files — drop it with the file.
