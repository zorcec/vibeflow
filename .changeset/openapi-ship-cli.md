---
"@vibeflow-tools/cli": patch
---

Ship the OpenAPI spec with the CLI: `vibeflow openapi [--yaml]` prints the bundled `/api/v0` contract to stdout with no server needed (pipeable into codegen/CI), and the package now carries `dist/openapi.json` + `dist/openapi.yaml` (resolvable as `@vibeflow-tools/cli/openapi.json`). Both are generated from `docs/api/v0-contract.json`, never hand-maintained. No existing endpoint changed.
