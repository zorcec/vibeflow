---
"@vibeflow-tools/cli": patch
---

`notifications --follow` prints one line for a burst of changes to the same task. A run of task updates is held for a couple of seconds (never more than five), so a follower sees the newest state of that task instead of every intermediate step — while a comment, a deletion or a claim flushes that task's burst and appears immediately. A burst still waiting when the follower stops is printed before it exits.
