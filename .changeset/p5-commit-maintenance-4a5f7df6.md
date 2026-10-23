---
"@vibeflow-tools/cli": patch
---

Route explicit `tasks --commit` and the `tasks --normalize` / `tasks --reindex-sort-keys` maintenance modes through the shared operation layer. `tasks --commit` runs `commitTaskPathsOperation` (one listing-based resolver, pathspec-scoped commit that never sweeps another lane's staged work, HEAD link on a clean tree, best-effort auto-push that still runs under `--json`); `normalizeTaskStore` and `reindexTaskSortKeys` own the preview/apply effects with minimal writes, quarantine and partial-write reporting. One deliberate flip: `--normalize --apply --dry-run` is now a preview (dryRun overrides apply, like every other operation). CLI envelopes, exit codes, `--yes`/`--dry-run` semantics, and human preview blocks are unchanged. All P5 temporary registry bypass entries are removed.
