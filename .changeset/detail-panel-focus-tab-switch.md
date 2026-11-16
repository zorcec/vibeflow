---
"@vibeflow-tools/cli": patch
---

The comment box keeps focus when you switch to the Activity tab. The title
focus timer re-armed on every tab change, and because the panel's own comment
box is excluded from the don't-steal-focus guard, clicking Activity pulled
focus back to the title 50 ms later — typing `Link to #alpha` straight away left
only `L` in the box. Focusing the title now happens only when a task is opened.
