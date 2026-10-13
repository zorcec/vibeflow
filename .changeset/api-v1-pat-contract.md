---
"@vibeflow-tools/cli": patch
---

Add the PAT shared primitives and contract rows for Phase 2 tokens: `vbf_pat_` format helpers plus read-only/read-write scope presets in `@vibeflow-tools/api-core`, and `list-tokens` / `create-token` / `revoke-token` operations (cloud-only, `tokens:manage`) in the v1 contract with regenerated spec, registry, and manifest rows. No existing endpoint changed.
