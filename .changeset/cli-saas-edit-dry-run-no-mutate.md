---
"@vibeflow-tools/cli": patch
---

Fix `tasks --edit --dry-run` mutating the online board in SaaS mode

### Highlights

- `--dry-run` in online (SaaS) mode no longer PATCHes the backend — it prints the same preview shape as the local path and returns before any remote write ✨

The `editMode === "saas"` branch called `updateSaasTask` (and `addSaasComment`
when `--comment` was passed) with no dry-run guard — the local dry-run preview
sits after that branch, so it never protected it. A dry run now returns before
either remote call, keeping only the read-only `fetchSaasTask` conflict check,
and emits the same preview shape the local path uses (`payload:
{ dryRun: true, ... }` under `--json`; a `[dry-run] Would update task:` line in
human mode).
