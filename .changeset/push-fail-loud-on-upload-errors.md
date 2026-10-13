---
"@vibeflow-tools/cli": patch
---

`vibeflow push` now exits non-zero when attachment uploads fail. Previously a rejected upload (e.g. oversized file) printed a warning but still exited 0 while deleting the local files, so `push && ...` chains believed everything synced. The failed filenames were already listed; the exit code now says THAT it failed.
