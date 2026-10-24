---
"@vibeflow-tools/cli": patch
---

Store maintenance: heal schema-invalid task records at the schema boundary (`tasks --normalize`, dry-run by default, `--apply` to write; idempotent; honors `--json`). Empty/absent-normalizing `links` no longer survive a normalising write — so garbage local values stop winning every pull and local records converge with the server. The maintenance write is a surgical raw-JSON edit of the affected keys (legacy fields such as the singleton `commit` survive byte-for-byte; no `updated` bump).
