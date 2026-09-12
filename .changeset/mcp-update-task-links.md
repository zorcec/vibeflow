---
"@vibeflow-tools/cli": patch
---

MCP `update_task` now accepts a `links` array, so an agent can set, replace, or clear a task's parent/relates/blocks links. The field was missing from the tool's input schema, so Zod silently dropped it and `update_task` reported success while the link was never written. The array replaces the task's full link set (pass `[]` to clear), and each entry is validated against the post-replace state with the same self-link, dangling-target, duplicate and cycle checks the `--set-parent` path uses.
