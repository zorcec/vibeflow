---
"@vibeflow-tools/cli": patch
---

Remote reads are dramatically faster on large boards: listings no longer fetch every task's details up front, and `tasks --get <id>` issues one detail request instead of fetching the whole board. On the production board, `tasks --status todo` dropped from ~18s to ~6s with zero per-task requests. Read failures now name the HTTP status and path, and a failed remote read always reports loudly instead of silently falling back to the local store.
