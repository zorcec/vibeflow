---
"@vibeflow-tools/cli": patch
---

Quarantined records are loud now: `pull` warns when the merge skips quarantined local records, `push` emits the store-wide quarantine warning, and `list` already warned. Every surface emits one warning per run — the count and the first reason, never one line per file — on stderr in every mode and in the `--json` envelope. A warning is not a failure: successful runs keep exit code 0.
