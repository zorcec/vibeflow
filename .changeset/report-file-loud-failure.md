---
"@vibeflow-tools/cli": patch
---

`tasks --edit --report-file` now fails loudly instead of being silently ignored. Providing the flag on a task that is not a Research task exits with a usage error and leaves the task untouched, and using the flag without `--set-status review` exits with a usage error. Previously both invocations appeared to succeed: the report was neither uploaded nor deleted, yet the status change went through.
