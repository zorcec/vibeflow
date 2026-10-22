---
"@vibeflow-tools/cli": patch
---

Quarantined records are loud now (ticket 74d9c46f). `pull` warns when the
merge skips quarantined local records; `push` emits the store-wide quarantine
warning before its preflight abort propagates; `list` already warned. Every
surface emits ONE warning per run — the count and the first reason, never one
line per file — on stderr in every mode and, under `--json`, in the envelope
`notices` (pull/push) alongside the existing list envelope. A warning is not
a failure: successful runs keep exit code 0.
