---
"@vibeflow-tools/cli": minor
---

Push now uses the v0 batch import when the server offers it (ticket 8d3b2b81): a capability probe (`GET /api/v0/tasks/batch`, 404 or the legacy invalid-id 400 on old servers) selects the batch path with a byte-identical one-by-one fallback, chunks of at most 100 tasks with per-chunk timeout and retry, quota preflight refusal before chunk one, per-chunk disk checkpoint with resume, and bounded-concurrency file uploads that skip remote-present files, all reported through the existing push progress and refusal surfaces. Mutation not run (on-request only).
