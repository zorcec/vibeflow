---
"@vibeflow-tools/cli": patch
---

Fix MCP `create_task` silently dropping `links`. The tool accepted a `links` parameter but the input schema had no such field, so the key was stripped and the task was created unlinked while reporting success. `create_task` now accepts `links` with the same merge semantics `update_task` has: every listed pair is added, `parent` folds into the same union, and each pair is validated through the shared link rule, so a dangling target or a second parent is refused and nothing is created.
