---
"@vibeflow-tools/cli": minor
---

Rename the versioned API surface `/api/v1/**` -> `/api/v0/**` with no backwards compatibility: the old prefix answers 404, the contract source moves to `docs/api/v0-contract.json` (`info.version` is now `0.1.0` — the API is pre-stable and may break without a deprecation cycle), and `vibeflow openapi` prints the v0 spec. Scope names, the PAT model, the bearer gate and `/mcp` are unchanged; point cloud clients at `/api/v0`.
