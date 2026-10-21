---
"@vibeflow-tools/cli": patch
---

Fix `vibeflow pull` atomicity and summary honesty. Verification (manifest
version, entry counts, per-task hashes, per-file sha256/size) now runs first
inside `applyPullEntries` — the single choke point for staged writes — so a
corrupt archive throws `PullVerifyError` before the first store write no
matter which entry point the caller used, and the whole merge is planned
before it is executed. The pull no longer invents `mimeType` (or an `updated`
bump) on tasks the server record did not change: identical files are not
touched and unchanged tasks stay byte-identical, which keeps the next push
converged instead of re-uploading pulled tasks. Summary counts now reflect
exactly what was written — every task-file write is counted once as added or
merged. Non-verification apply failures report honestly that partial writes
may have occurred instead of claiming nothing was written.
