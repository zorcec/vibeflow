---
"@vibeflow-tools/cli": patch
---

`vibeflow push` now retries tasks whose files never made it, instead of
treating them as done forever.

The diff was id-only: a task that existed on the board was excluded from
every later push, so a file that failed to upload was permanently lost.
Measured on a real board: 1746 tasks synced while only 601 of ~790 files
were present, and `push` reported "everything is already pushed".

Now the board index keeps each task's `fileCount`, and a task is pushed
again when it is missing locally or when it has more local files than the
board reports. The re-push returns `existing: true` (no duplicate row) and
only the missing bytes travel, because the server skips files it already
has. A locally deleted file (remote count higher) is correctly ignored, so
it cannot drag the task back into every push.

The summary distinguishes the two reasons — `N task(s) to push (M already
on the board) (K already on the board and re-pushed only to sync missing
files)` — and the empty-diff line now says "all files synced" only when
that is actually true.
