---
"@vibeflow-tools/cli": patch
---

Fix the verify-before-review gate: it now looks for `baseline.json` in the real evidence directory (`.vibeflow/tasks/files/<task-id>`) instead of a hardcoded `.vibeflow/files/<task-id>` path that never held evidence. Unverified UI tasks are once again blocked from moving to review.
