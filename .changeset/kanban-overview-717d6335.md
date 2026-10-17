---
"@vibeflow-tools/cli": minor
---

The CLI kanban server now serves a read-only board overview page at `/overview`, linked from the board header ("Overview") and back. It renders board-level aggregates — counts by status, tasks done today and in the last 7 days, the oldest todo and in-progress tasks with age and board deep-links, and an assignee breakdown — computed client-side from the same `GET /api/tasks` payload the columns use, so no new API or data layer was added. Both routes serve the same inlined single-file shell (production npx packaging unchanged), the page uses only shared theme tokens and real table semantics, and it never mutates: no drag, no writes, card references link back to `/kanban#task-<id>` (ticket 717d6335).
