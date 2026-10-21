---
"@vibeflow-tools/cli": patch
---

Store maintenance: heal schema-invalid task records at the schema boundary (`tasks --normalize`, dry-run by default, `--apply` to write; idempotent; honors `--json`). The `type` reader now accepts exactly the documented vocabulary (Task/Bug/Feature/Enhancement/Research) and treats anything else as absent, and empty/absent-normalizing `links` no longer survive a normalising write — so garbage local values stop winning every pull and local records converge with the server. The maintenance write is a surgical raw-JSON edit of exactly those two keys (legacy fields such as the singleton `commit` survive byte-for-byte; no `updated` bump). Display type normalization now recognizes the same five values.
