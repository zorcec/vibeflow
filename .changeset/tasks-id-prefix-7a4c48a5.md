---
"@vibeflow-tools/cli": patch
---

Tasks id-prefix unification (ticket 7a4c48a5). Every id-taking `tasks`
flag now resolves through the one resolver `resolveSaasTaskId` — exact id
wins, else a UNIQUE prefix; an ambiguous prefix is `E_AMBIGUOUS` naming the
candidates; only then `TASK_NOT_FOUND`; an empty id is refused, never a
prefix of everything. Previously `--edit` sent the raw prefix to the
server while `--get` resolved it, so `--edit swy7ox61` printed "Task not
found" for a task `--get swy7ox61` displayed. Also fail-fast: a review
transition missing `--commit-message` while auto-commit is ON is refused
with `COMMIT_MESSAGE_REQUIRED` before any other output (previously
discovered at the end of a long run), and the requirement is stated on the
`--commit-message` flag help.
