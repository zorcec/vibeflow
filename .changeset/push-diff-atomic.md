---
"@vibeflow-tools/cli": patch
---

Diff-based, per-task-atomic push: `vibeflow push` fetches the board's
task ids FIRST (one shared paginated helper, `fetchOnlineTaskIds`, also
used by the login-time prompt instead of its inline loop) and pushes
ONLY the diff — an empty diff prints "Everything is already pushed (N
tasks on the board)." and exits 0 without further network calls.
`--dry-run` reports the same diff. The tree-import path skips whole any
task that cannot fit one import call (oversize file vs the preflight's
`maxFileBytes`, task bytes vs `maxBytes`, file count vs `maxFiles`) —
never created partially, never recorded as done, reported as retryable
with the exact reason in the human summary and `--json`, and retried on
the next run. Chunking is task-atomic (no file-list splitting); only
pushed tasks' local files are deleted afterwards.
