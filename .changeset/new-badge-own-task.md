---
"@vibeflow-tools/cli": patch
---

stop showing the "new" badge for tasks you created yourself

Core `createTask` now seeds `openedBy` with the creating user — the same id
the board injects as `window.__VIBEFLOW_USER__` (`getCurrentUserId()`), and
the same one `markTaskOpened` records. No create surface (CLI `--add`,
`POST /api/tasks`, tRPC `createTask`, MCP `create_task`) passed `openedBy`,
and the unread dot is `!openedBy.includes(currentUserId)`, so every task you
added showed as unread to you. Tasks created by someone else still show the
dot until you open them.
