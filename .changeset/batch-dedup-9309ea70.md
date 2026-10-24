---
"@vibeflow-tools/cli": patch
---

Re-pushing tasks that are already on the board no longer inflates the created count. The server now answers each already-present task with its existing id, so links still heal but the summary prints honestly (e.g. "0 created, N already existed" for a pure re-push).
