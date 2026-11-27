---
"@vibeflow-tools/cli": patch
---

A change made from the local board's own data layer now reaches a watching agent.

The board has two write paths and only one of them told the notification feed what happened: the HTTP routes confirm their effects as events, while the board's internal data layer sent a UI update and stopped there. So a status change or a comment made from the kanban through that path was invisible to `vibeflow notifications --follow`, even though the card on screen changed.

Both paths now go through one seam, so the projection, the noise filter (a bookkeeping-only patch still emits nothing) and the vocabulary cannot diverge. Comment edits and deletions still emit nothing, exactly like the HTTP path.
