---
"@vibeflow-tools/cli": minor
"@vibeflow-tools/api-core": minor
---

Contract-first: two new v0 operations for batch import (ticket b4c525fa, server side).
`POST /api/v0/tasks/batch` creates up to 100 tasks per chunk with per-item
`[{ id } | { error: { code, message } }]` results in request order (one bad item never
sinks the batch); `GET /api/v0/tasks/batch` is the preflight probe reporting remaining
task capacity before the first POST. Additive only — no existing operation changed.
