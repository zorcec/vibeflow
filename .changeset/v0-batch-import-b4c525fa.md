---
"@vibeflow-tools/cli": minor
"@vibeflow-tools/api-core": minor
---

Two new v0 batch-import operations: `POST /api/v0/tasks/batch` creates up to 100 tasks per chunk with per-item results in request order (one bad item never sinks the batch); `GET /api/v0/tasks/batch` is the preflight probe reporting remaining capacity before the first POST. Additive only — no existing operation changed.
