---
"@vibeflow-tools/cli": patch
---

After-hook envelopes now carry the confirmed task snapshot and activity object. Previously every after-hook received `task: null` and had to re-read the task store; hooks now get the written record directly (run-level events such as push, pull, and verify still carry no single task).
