---
"@vibeflow-tools/cli": patch
---

Make `tasks --commit` path-scoped so it can no longer sweep another lane's staged work into a task's commit. The command now commits only the task's own record (its JSON file and attachments directory) by default, or exactly the paths given after `--`:

```
vibeflow tasks --commit --task <id> --message "<msg>" -- <paths...>
```

Every other staged path is left untouched in the index, and a warning names them when no paths are given. When there is nothing to commit the command no longer fails — it links the existing HEAD to the task and says so, so a task is never left without a commit link. The `--commit` workflow hints now show the pathspec form.
