---
"@vibeflow-tools/cli": patch
---

Add minimal agent badge to kanban task cards and detail panel.

- TaskCard footer now shows a purple "Agent" pill with Bot icon when `task.agent` is set.
- KanbanListView rows also display the agent badge inline with the title.
- TaskDetailsTab metadata section includes an "Agent" tile when present.
- All styles blend with existing badge sizing (font-size 10, compact padding, purple tint).
