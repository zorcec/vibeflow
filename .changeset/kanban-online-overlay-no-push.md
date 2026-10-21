---
"@vibeflow-tools/cli": patch
---

The kanban online-mode overlay no longer offers a "Push local tasks" button or a
"Keep local files" toggle. Pushing is a standalone, explicit command
(`vibeflow push`) with its own flags, so duplicating it behind a one-click button
inside an informational banner was misleading: it silently reused the local
store's options and gave no way to see what would be sent. The overlay now only
reports state — which board you are connected to, and a link to open it. The
`POST /api/push` route and the `push` command are unchanged.
