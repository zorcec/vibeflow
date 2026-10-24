---
"@vibeflow-tools/cli": patch
---

Online listings now request the board's kanban order from the server: the default unfiltered root-only listing and the `--children` / status-filtered listings each render the first page in one request with the same rows as a full client-side sort. `--status done`, type/user/tag filters, and prefix resolution still read the full board; servers that ignore the new parameters fall back to the full scan automatically.
