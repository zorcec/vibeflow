---
"@vibeflow-tools/cli": patch
---

Every id-taking `tasks` flag now resolves through one rule: an exact id wins, else a unique prefix; an ambiguous prefix is refused naming the candidates, and an unknown id says not found. Previously `--edit` sent the raw prefix to the server while `--get` resolved it, so `--edit <prefix>` failed for values `--get <prefix>` displayed. A review transition missing `--commit-message` while auto-commit is on is now refused up front with `COMMIT_MESSAGE_REQUIRED` instead of failing at the end of a long run.
