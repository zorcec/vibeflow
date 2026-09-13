---
"@vibeflow-tools/cli": patch
---

Scope the review auto-commit to the task's own file and attachments instead of committing the whole shared index.

Concurrent agent lanes share one git index in one working tree, so the CLI's plain `git commit` committed whatever any lane had staged: a lane's screenshots and task JSON could land inside a different task's commit, and a foreign deletion was once swept into an unrelated commit. `git show <sha>` then lied about what a task changed. The auto-commit now commits only staged paths that belong to the task being recorded — its `.vibeflow/tasks/<date>/<id>.json` and files under `.vibeflow/tasks/files/<id>/` — and leaves any other lane's staged files untouched.

When the task's own file is not staged the commit no longer runs, and the failure message now says the task WAS updated (its status and comment are already saved) and names the exact path to stage, rather than the old wording that implied nothing had been written.
