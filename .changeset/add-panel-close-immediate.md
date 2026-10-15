---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

The kanban "Add Task" panel no longer waits for the `task.create` round-trip before closing. Clicking Add closes the panel immediately while the already-painted optimistic card stays visible on the board; files pasted during creation still upload in the background once the create resolves with the real id.
