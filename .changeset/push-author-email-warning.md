---
"@vibeflow-tools/cli": patch
---

Make the `push` attribution warning name a gap that can actually be closed.

The warning advised running `vibeflow authors link` for every task with a commit missing `authorEmail`, but that command resolves a commit through its sha in git history. A commit entry with an empty sha can never be resolved, so the advice was permanent: the command reported "0 unresolved" while the warning stayed. Only linkable commits are counted now.
