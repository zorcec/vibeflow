---
"@vibeflow-tools/cli": patch
---

`vibeflow push` fetches the board's task ids first and pushes only the diff — an empty diff prints "Everything is already pushed" and exits 0 with no further network calls. `--dry-run` reports the same diff. Tasks that cannot fit one import call are skipped with the exact reason and retried on the next run, never created partially.
