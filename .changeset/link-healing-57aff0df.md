---
"@vibeflow-tools/cli": patch
---

Push links heal across runs (ticket 57aff0df). When a link endpoint
is missing from the current run's idMap, the CLI resolves it against
the board by client id (one GET, cached per run) instead of skipping
forever — tasks pushed in earlier runs (locals since deleted) link up
on the next push. Truly unknown targets keep the clean skip. Resolved
ids write back into the idMap so the file phase uploads their
attachments too.
