---
"@vibeflow-tools/cli": minor
---

Bulk-push progress (7db36f78): pushing many unsynced tasks no longer runs silent — the shared `createTasksOneByOne()` loop now reports `Pushing done/total` after every task, so both the login-time push and the standalone `push` command show a from/to counter with a visual bar on a TTY and counter-only line updates when piped, all on stderr so stdout and `--json` stay clean, with the existing pushed/skipped summary lines unchanged. Stays on current deps: the renderer is ~20 lines in `src/auth/login.ts`, no new progress-bar library.
