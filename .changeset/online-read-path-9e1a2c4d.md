---
"@vibeflow-tools/cli": patch
---

Fixed the remote read path that sank large boards: `fetchSaasTasks` no longer hydrates by default (listings need only the `commentCount`/`fileCount` the list items already carry), opt-in hydration runs through a bounded pool (5 in flight, sequential sub-requests per task) instead of `Promise.all` over the whole board, and `tasks --get <id>` issues one `GET /api/v0/tasks/:id` detail request instead of fetching and hydrating the entire board. The parent-change path reads the edited task's links via the same detail request. Read failures now name the HTTP status + request path (or the network message) instead of the catch-all unreachable-backend message, and a failed remote read always reports loudly — never a silent fall back to the local store. Measured on the production board: `tasks --status todo` went from 18.4s (plus ~3580 hydration requests and ~5000 plan queries) to ~5.8s listing the remote board with zero per-task requests.
