---
"@vibeflow-tools/cli": patch
---

MCP task tools now match the CLI on writes and input handling. `update_task` honours `parent` (set/replace/clear through the same helper as `--set-parent`/`--no-parent`) instead of silently ignoring it, and every tool rejects unrecognized fields with a -32602 error instead of stripping them — the same accept-nothing-unknown rule as the CLI's `unknown option` refusal. `create_task`/`update_task` take the same `fields` selector as `list_tasks`/`get_task` (mirrored by `tasks --add/--edit --json --fields`), so a status flip need not echo the whole ticket. The `update_task` schema now states the review gate up front: review requires `comment`, annotated tasks require a verdict, `commitMessage` is required when auto-commit is on, and Research tasks must not carry a verdict.
