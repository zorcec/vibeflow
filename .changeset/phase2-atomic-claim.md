---
"@vibeflow-tools/cli": patch
---

Atomic task claim: `--next` now re-checks status inside a lock, preventing double-claims under concurrent access.
