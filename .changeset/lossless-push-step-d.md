---
"@vibeflow-tools/cli": minor
---

Push sends the complete local record, and `vibeflow authors link` attributes
commits to their git author.

The tree-import manifest now carries each task's full record (minus the
`authStateEnc` credential and the in-memory `filePath`), so a server that
advertises `lossless: true` can mirror it verbatim instead of reconstructing a
subset. Without this the server side had nothing to store: comments, commits,
`openedBy`/`expandedBy` and non-parent links were never sent.

`vibeflow authors link [--dry-run]` resolves every local commit sha to its
ORIGINAL git author email and records it as `commits[].authorEmail`. It fills
only missing values, reports a different existing value as a conflict and never
overwrites it, never guesses a task-level email, and never touches the `author`
text. Enrichment is a separate reviewable step because `.vibeflow` is
git-tracked; a second run is a no-op.

CLI-created comments capture `git config user.email` as `authorEmail` (absent,
never `""`, when unavailable — with one warning per process), so a comment can
later attach to a real account. `author` stays the actor text.

`push` only reports how many tasks still lack commit author emails; it never
writes local data.

Also fixes a real normalization trap: the task/comment/commit normalizers
rebuilt the record and silently dropped unknown keys, which would have made the
`raw` mirror a lie.
