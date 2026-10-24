---
"@vibeflow-tools/cli": patch
---

Push links now heal across runs. When a link endpoint is missing from the current run, the CLI resolves it against the board by client id and writes it back, so tasks pushed in earlier runs (whose locals are since deleted) link up on the next push instead of being skipped forever. Truly unknown targets keep the clean skip.
