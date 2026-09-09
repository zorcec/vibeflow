---
"@vibeflow-tools/cli": patch
---

Server: accept legacy comment IDs in `isValidCommentId` (and the matching tRPC `commentIdSchema`). SaaS-era IDs (10–14 lowercase alphanumerics such as `mnrrhpi0f9mxv`) and hand-written `-`/`_` slugs (e.g. `fix-comment-1`) no longer 400 on comment PATCH/DELETE. Traversal and non-conforming IDs are still rejected.
