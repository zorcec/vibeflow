---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

Compact cards inline file/child/comment counts, presence chips go high-contrast right, file uploads leave a trace

Compact view cards now show the nonzero file, subtask and comment counts inline with the title (opening the files tab, the task, and the activity tab respectively) instead of hiding them; done-column cards stay title-only. The detail panel's co-presence stack moved to the right edge of the status row and its chips use a darkened fill of the same per-person hue, so white initials clear WCAG AA on every hue (measured floor 5.02:1). Attaching a file now writes the same system activity entry removing one always wrote, and the open panel refreshes its activity and files without a reload. No behaviour changes otherwise: comment edits still leave no feed entry, and presence stays informational and never locks editing.
