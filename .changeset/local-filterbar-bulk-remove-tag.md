---
"@vibeflow-tools/cli": patch
---

Add bulk tag Remove to the kanban board's Tags filter: each tag row offers a confirm-then-remove action that strips the tag from every matching task and refreshes on success. The core operation stages all replacements under deterministic per-task lock order with byte-exact backups, rolls every file back on failure, and broadcasts once; crash-window semantics are all-or-nothing against an exception and best-effort against a kill, same as the single-task path.
