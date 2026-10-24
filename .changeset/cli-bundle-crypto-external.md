---
"@vibeflow-tools/cli": patch
---

Fixed the published `vibeflow` binary crashing on every invocation with `Dynamic require of "crypto" is not supported`. The build now keeps Node builtins external, and a bootsmoke check spawns the built artifact to prove it starts.
