---
"@vibeflow-tools/cli": patch
---

Isolate every test-spawned CLI from the operator's home directory. All CLI child environments now flow through a single helper (`tests/e2e/spawn-isolated.ts`) that pins `HOME` to a caller-owned temp dir, strips `GIT_*` inheritance, pins `GIT_CEILING_DIRECTORIES`, and drops redirect inheritance (`VIBEFLOW_API_URL`, `VIBEFLOW_PROJECT_DIR`, introspection skip-guards) unless passed explicitly per run. Test-only change: no product behaviour affected.
