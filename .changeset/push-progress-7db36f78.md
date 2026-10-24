---
"@vibeflow-tools/cli": minor
---

Pushing many unsynced tasks no longer runs silent: the push loop reports `Pushing done/total` after every task, with a visual bar on a TTY and counter-only updates when piped, all on stderr so stdout and `--json` stay clean.
