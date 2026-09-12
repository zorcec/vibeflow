---
"@vibeflow-tools/cli": patch
---

Fix task `author` attribution: `tasks --add` and status transitions now stamp the task-store git identity, so an agent-created or transitioned task shows the same author as a human-created one.
