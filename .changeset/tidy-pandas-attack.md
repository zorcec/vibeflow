---
"@vibeflow-tools/cli": patch
---

Proof screenshots no longer overwrite a ticket's annotation baseline: `POST /api/tasks/:id/screenshot` writes the first attach to `<id>.png` as before, but every later attach lands in a distinct `<id>-proof-<n>.png` and leaves `task.screenshot` pointing at the original annotation image.

Servers no longer default to the repo's live store when booted without an explicit project: `kanban`/`serve`/MCP honour `$VIBEFLOW_PROJECT_DIR` when no `--project` or positional dir is given, so e2e and dev boots can point at a scratch store. An explicit path always wins over the env var.
