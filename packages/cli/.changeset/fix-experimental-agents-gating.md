---
"@vibeflow-tools/cli": patch
---

Fix experimentalAgents flag to properly hide agent UI by default. Changed all gating conditions from `experimentalAgents !== false` (which evaluated to true when undefined) to `experimentalAgents === true`, ensuring agent features are hidden unless explicitly enabled.
