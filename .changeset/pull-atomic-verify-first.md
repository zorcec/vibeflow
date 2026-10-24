---
"@vibeflow-tools/cli": patch
---

`vibeflow pull` now verifies the archive (manifest version, entry counts, per-task hashes, per-file sizes) before writing anything — a corrupt archive fails before the first store write, and the whole merge is planned before it executes. Tasks and files the server record did not change are left byte-identical, which keeps the next push converged instead of re-uploading pulled tasks. Summary counts now reflect exactly what was written, and non-verification failures report honestly that partial writes may have occurred instead of claiming nothing was written.
