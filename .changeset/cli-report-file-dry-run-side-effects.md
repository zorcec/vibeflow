---
"@vibeflow-tools/cli": patch
---

Fix `tasks --edit --dry-run` with `--report-file` mutating before validation fails

### Highlights
- ✨ `--dry-run` with `--report-file` is now a true dry run: zero uploads, zero file moves
- ✨ A review run that fails validation (e.g. missing `--comment`) no longer uploads or deletes the report first

The `--report-file` upload used to run before the review gate, so a refused
run had already saved the attachment and deleted the source file — and
`--dry-run` mutated too. The path is now validate (read-only, keeps its
`E_NOT_FOUND` / `E_USAGE` precedence), then gate (which accepts the carried
report for gate 5), then upload — skipped entirely under `--dry-run`. The
source file is still consumed (moved, not copied) on a real successful run;
copy it yourself first if it must keep living in `docs/`.
