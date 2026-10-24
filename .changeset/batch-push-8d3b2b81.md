---
"@vibeflow-tools/cli": minor
---

`vibeflow push` now uses the batched import when the server offers it, falling back to the one-by-one path on older servers. Tasks go up in chunks of at most 100 with per-chunk timeout and retry, quota is checked before the first chunk, each chunk is checkpointed to disk so a killed push resumes, and file uploads skip files the server already holds. Progress, refusals, and `--json` output are unchanged.
