---
"@vibeflow-tools/cli": minor
---

`vibeflow tasks --add --parent <task-id>` creates a task as a child of an existing task in one command. `--parent` accepts a full id or a unique prefix (resolved the same way `--get`/`--set-parent` resolve ids), writes the same `parent` link the `--edit --set-parent` path writes (`links: [{ taskId, type: "parent" }]`), and rejects a dangling target with the same wording. It is `--add`-only; without `--add` it prints a usage error. The MCP `create_task` tool and `POST /api/tasks` accept the same optional `parent`, and `--add --json` returns the new task with its `links` field. `--edit` keeps using `--set-parent` / `--no-parent` unchanged.
