---
"@vibeflow-tools/cli": patch
---

Operation registry ratchet (ticket 2d789b27, P0 — no product behavior change). Adds the machine-readable CLI/MCP operation contract: 29 operations with mode (local/online/both) and mapping kind in `core/operation-registry.ts`, 17 known intentional divergences as data in api-core `operation-surface-contract.ts`, and a generator script emitting the checked-in `operation-registry.gen.json` artifact (19 command nodes, 12 MCP tools). New ratchet suite fails on unregistered flags, stale entries, schema drift, or un-regenerated mode changes; characterization tests pin local-mode list/get/claim/edit/comment/push/pull behavior.
