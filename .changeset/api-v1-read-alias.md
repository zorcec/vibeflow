---
"@vibeflow-tools/cli": patch
---

Add the local `/api/v0` read alias (GET only, delegating to the existing handlers with zero behaviour change) behind per-scope checks, plus the offline `/api/docs` viewer rendering the served contract. No existing endpoint changed; unmounting one router line rolls back.
