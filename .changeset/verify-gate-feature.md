---
"@vibeflow-tools/cli": minor
"@vibeflow-tools/ui": minor
---

feat: Add optional verify gate in settings enforcement

- Added `requireVerifyBeforeReview` toggle in Settings > Enforcement
- When ON, agents must run `vibeflow verify` before setting status to review
- Gate auto-skips for non-UI tasks (no URL/selector)
- Added `--skip-verify` flag to bypass gate when needed
- Updated agent instructions to show verify step before review when gate is ON
- Failed verification no longer marks task as verified
- `verified` flag resets when claiming task for new work
