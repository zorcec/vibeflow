---
"@vibeflow-tools/cli": minor
---

Push now sends the complete local record, and a server that supports it mirrors it verbatim instead of reconstructing a subset — so comments, commits, `openedBy`/`expandedBy`, and non-parent links survive the round trip. Record normalization preserves unknown keys instead of silently dropping them. `vibeflow authors link [--dry-run]` resolves each commit to its original git author email, filling only missing values and reporting conflicts without overwriting. CLI-created comments capture `git config user.email` as `authorEmail` (absent when unavailable, with one warning per process).
