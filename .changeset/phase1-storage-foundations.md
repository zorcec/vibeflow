---
"@vibeflow-tools/cli": patch
---

Concurrent task writes now safely serialized via cross-process lock. GET endpoints are side-effect-free. Unified priority sorting across CLI and API.
