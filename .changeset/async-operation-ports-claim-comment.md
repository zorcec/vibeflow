---
"@vibeflow-tools/cli": patch
---

MCP `update_task` now reports a failure when the task edit is saved but the follow-up comment cannot be recorded, instead of answering success. The edit itself is preserved and the error is marked non-retryable so clients do not re-apply it.
