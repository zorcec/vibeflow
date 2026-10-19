---
"@vibeflow-tools/cli": minor
---

`vibeflow push` no longer deletes anything locally.

Push used to remove every pushed task's JSON, its asset directory and its
screenshots by default, so a routine command consumed the local store. That
delete is unrecoverable by push, and measured in production one run removed
2416 files — including six attachments whose upload had just failed, taking the
last reference to those files with it.

Keeping local files is now the default. Deletion requires an explicit
`--prune-local`, and even then the whole prune is refused whenever any file
upload failed, so a partial push can never destroy local-only data.
`--keep-local-files` still parses (now a no-op) for existing scripts.
