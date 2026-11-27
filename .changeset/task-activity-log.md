---
"@vibeflow-tools/ui": minor
"@vibeflow-tools/cli": minor
---

**A task's detail panel now shows its own activity log.**

The board's notification feed is narrowed to the open task (`?taskId=`), so an
open panel lists what actually happened to that task — claimed, updated, status
moved, verified — each row stamped with how long ago it happened. The header
stamps the last successful read, so a log that stops refreshing says how old it
is instead of posing as live, and a failed refresh keeps the rows already read.
An older board ignores the task-scoping parameter and answers the whole feed;
the panel keeps this task's events only, never a mixture.

The log is read-only and carries no "now working on" line: the feed records what
was delivered, so it is only ever honest in the past tense.
