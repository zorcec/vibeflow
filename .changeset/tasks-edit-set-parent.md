---
"@vibeflow-tools/cli": patch
---

Add `--set-parent <task-id>` and `--no-parent` options to `tasks --edit` for setting, replacing, or clearing a task's parent link (validated: parent must exist, no self-parenting, no cycles).
