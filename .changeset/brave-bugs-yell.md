---
"@vibeflow-tools/cli": patch
---

fix(cli): align tRPC/REST semantics, add router tests, and harden agent API

- tRPC `tasks` and `searchTasks` now count only non-deleted comments and read file counts from task metadata instead of the filesystem.
- tRPC `updateTask` now accepts `tags`, `sortKey`, and `branchName` like the REST endpoint.
- Removed an unused `pageScope` parameter from tRPC `searchTasks`.
- Kanban multi-select agent runs now use the task/model or configured default model instead of a hardcoded value.
- WebSocket task upserts now filter deleted comments when computing `commentCount`.
- Added unit tests for the tRPC router and API validation helpers.
- Validated task IDs, model names, and agent names in the agent run/stop APIs to prevent option injection.
- Increased Vitest timeouts to keep the pre-commit suite stable under load.
