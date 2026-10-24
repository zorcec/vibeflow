---
"@vibeflow-tools/cli": patch
---

Logged-in state now reads "online" everywhere: the login banner, the status line, push output, help text, and README. `vibeflow auth login`, `vibeflow auth logout`, and `vibeflow auth status` are the canonical commands — bare `vibeflow auth` shows the same status, and the old bare `login` / `logout` spellings still work but print a redirect notice.
