---
"@vibeflow-tools/cli": patch
---

Guard the synced task store (ticket 8538344b). New `check:store` script
(`packages/cli/scripts/check-store.mjs`, also as `src/core/task-store-check.ts`
for importable use) walks the `.vibeflow` tasks tree and fails on any task
file with a JSON parse error or an unresolved git conflict marker, naming
every offending path (~50ms for 2000 files). Wired into the pre-commit hook
so a conflicted store can never be committed silently again. Command docs now
state the rule: never `git add -A` a synced store with an unresolved merge —
resolve, pull, verify, then add.
