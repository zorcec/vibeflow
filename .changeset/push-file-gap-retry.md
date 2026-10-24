---
"@vibeflow-tools/cli": patch
---

`vibeflow push` now retries tasks whose files never made it, instead of treating them as done forever. Previously the diff was id-only: a task on the board was excluded from every later push, so a failed file upload was lost permanently — measured on a real board, 1746 tasks synced while only ~601 of ~790 files were present, yet push reported "everything is already pushed". Now the board index keeps each task's file count, and a task is re-pushed when it is missing locally or has more local files than the board reports — the re-push returns `existing: true` (no duplicate row) and only the missing bytes travel. The summary distinguishes the two reasons, and the empty-diff line now says "all files synced" only when that is actually true.
