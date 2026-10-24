---
"@vibeflow-tools/cli": minor
---

Push now carries a whole subtree — tasks with parent links and files — in one request per chunk (up to 100 tasks / 50 files / 25 MB), instead of one write per task, link, and file. Parent links resolve in-manifest first, else against tasks already on the board, so children can never be orphaned by a failed follow-up phase. Old servers without the endpoint fall back to the legacy phases automatically.
