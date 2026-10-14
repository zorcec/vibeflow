---
"@vibeflow-tools/ui": patch
---

Detail-pane markdown editors no longer call the board API for the `#` mention index or task hover cards. Both now take caller-provided in-memory data (`mentionTasks` / `taskLookup`), which the detail panel threads from its task list — so opening a task no longer fires `GET /api/tasks` requests that 404 on hosts without that route. The legacy fetches remain only for callers with no task list (standalone file preview, remote board client).
