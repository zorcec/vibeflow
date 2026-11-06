---
"@vibeflow-tools/cli": patch
---

Ticket 53c98e06: pin the `--status` filter guarantee — a filtered listing never returns a root whose status isn't the filtered one. New e2e `tasks-status-filter-truthfulness` asserts on raw `--json` that every returned root's status exactly equals the filter (todo, backlog, in-progress, done), that other-status roots are absent, that listed status fields agree with `--get`, and that the pinned todo-child-of-backlog-parent visibility (with parent context) still holds. No production code changed: every listing path already re-filters client-side with exact `t.status === query.status` after any server hint, so the original incident was an orchestrator presentation error on a concurrently mutated board, not a tool bug.
