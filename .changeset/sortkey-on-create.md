---
"@vibeflow-tools/cli": patch
---

Auto-assign a `sortKey` when a task is created without one, so tasks created via the CLI, MCP or HTTP API always carry a well-formed column ordering key.
