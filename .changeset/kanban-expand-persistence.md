---
"@vibeflow-tools/cli": minor
---

Kanban card expand/collapse state is now persisted per user and restored across reloads; the unread indicator only shows for tasks you have not opened.

### Highlights

- Card children stay expanded after a page reload — the choice is stored per user on the task and re-applied from the payload.
- The blue unread dot now compares against the real board user id instead of a placeholder, so it clears as soon as you open a task.
