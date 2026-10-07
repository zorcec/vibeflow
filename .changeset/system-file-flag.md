---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

fix(cli, ui): engine-written files carry an explicit system flag instead of name matching

`TaskFileRef` / `FileInfo` / `FileEntry` gain an optional `system?: boolean`,
stamped at write time: `saveFile()` accepts `{ system: true }`, and all
engine writers pass it (verify evidence via `storeEvidence()` plus the
page-diff back-fill, and both server baseline routes). User uploads (UI
upload route, overlay paste, MCP `attachFile()`, `--report-file`) default
to unflagged. The kanban `FilesList` groups by `f.system === true`, so the
old `baseline-*.json` regex and the dead `{taskId}.png` matcher are gone,
and the SYSTEM caption now states the timing accurately (baselines at
annotation time, verify evidence re-captured on every run).

Pre-flag boards migrate lazily: the existing `migrateLegacyLinkedRefs` hook
(which already runs on every `saveFile`/`deleteFile`) backfills `system: true`
onto the 11 known engine filenames — the single remaining place names are
matched — and the existing `migrateAllLegacyLinkedRefs` sweep (now also run
once at server startup) covers untouched tasks. The backfill is idempotent
and never clears a flag.
