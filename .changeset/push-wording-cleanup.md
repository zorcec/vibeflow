---
"@vibeflow-tools/cli": patch
---

Push output now reads one fact per line (wording only — no behaviour, counting, or `--json` change): a single preamble line (local tasks, board count, what will actually be sent and why, e.g. re-sends to sync missing files) replaces the old two-parenthetical sentence whose counts contradicted each other on repair runs; the result is a `Push complete: N created, M updated, K unchanged` block plus a `Files: N uploaded, M skipped` line using the same counters the `--json` envelope carries; a no-op reads `Nothing to push — board already has all N task(s).` and never `Pushed 0`; refusals ride on their own yellow warning line instead of inside the green success sentence. Mutation not run (on-request only).
