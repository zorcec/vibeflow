---
"@vibeflow-tools/cli": patch
---

Kanban drag-and-drop: drag state is now released on every drop outcome, so a drop onto a child row or children zone can no longer leave the board stuck. The drop handler clears the drag context in a `finally` (a rejected/ignored drop counts too), the window-level `dragend` cleanup also strips leftover `dragging`/`dnd-*` classes from the DOM, tree child rows register their drag source before touching `dataTransfer` and clear their own drag marker on `dragend`, and a rejected reparent in the detail-panel relations tree releases the drag session instead of leaving it latched.
