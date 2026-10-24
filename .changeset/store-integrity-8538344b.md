---
"@vibeflow-tools/cli": patch
---

Never commit a synced store with an unresolved merge: a new `check:store` script walks the `.vibeflow` tasks tree and fails on any file with a JSON parse error or git conflict marker, naming every offending path, and it runs in the pre-commit hook so a conflicted store can never be committed silently.
