---
"@vibeflow-tools/cli": minor
---

Tree-import push (ticket bulk-429). The push now carries a whole subtree
— tasks with parent links and files — in one multipart call per chunk
(`POST /api/v0/tasks/import`, up to 100 tasks / 50 files / 25 MB),
instead of one write per task, link, and file. Parent links resolve
in-manifest first, else against tasks already on the board, so children
can never be orphaned by a failed follow-up phase; chunking keeps a
large push to ~20 calls at one write unit each. Inter-chunk pacing
(5 s) and bounded Retry-After resume are shared with the task loops,
skip-if-present is enforced by the server's name index, and checkpoints
still resume killed pushes. Old servers without the endpoint fall back
to the legacy one-by-one phases byte-identically.
