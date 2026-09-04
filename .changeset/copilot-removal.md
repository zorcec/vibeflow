---
"@vibeflow-tools/cli": patch
---

Remove unused GitHub Copilot integration leftovers (dead agent feature module). No public API surface change — the feature was never wired into the CLI entry points. Also removes a stored token path from the codebase (security hygiene).
