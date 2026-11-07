<!-- highlight -->
---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/api-core": patch
"@vibeflow-tools/ui": patch
"@vibeflow-tools/shared": patch
---

Needs-attention flag on tasks. `tasks --edit <id> --set-attention --comment "<reason>"` flags a task (amber "Needs attention" badge on the card, child rows and detail header); `--set-attention` without `--comment` is refused with `E_USAGE` since the comment carries the reason. `--clear-attention` clears the flag with no comment. MCP `update_task` gains matching `setAttention` / `clearAttention` inputs with the same comment requirement and refusal codes. The flag change reads in the activity feed as an `attention` change row (clear to flagged) next to the reason comment. The field flows end to end: task type, record schema, online PATCH body, remote-task-store round-trip, kanban merge, and field diff.
