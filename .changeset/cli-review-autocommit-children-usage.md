---
"@vibeflow-tools/cli": patch
---

Review auto-commit no longer misses unstaged task files, and `--children` with a task ID is a usage error

Two outputs that misled callers now behave:

- `tasks --edit <id> --set-status review --commit-message "..."` stages the
  task's own file (and its attachments directory) itself before committing,
  so the usual case — status and comment just saved, nothing staged —
  commits instead of printing "Task WAS updated ... but the commit did NOT
  happen" with exit 0. Untracked new task files are staged the same way; a
  record that is already fully committed links the current HEAD instead of
  failing. Genuine git failures (not a repository, git errors) still report
  `GIT_COMMIT_FAILED` without implying success.
- `tasks --children <task-id>` no longer prints "No tasks found" with exit
  0 (the id was parsed as the `[dir]` positional, so the CLI listed an
  empty non-store). It is now an explicit `E_USAGE` error naming
  `--children` and pointing at `tasks --get <id>`; `--children --help`
  teaches the same.
