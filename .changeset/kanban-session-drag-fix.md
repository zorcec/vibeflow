---
"@vibeflow-tools/cli": patch
---

**Kanban drag & drop fix.** Drag & drop could look completely dead on boards with parent-child tasks. The card and children-zone `dragover` handlers resolved the dragged task from the board's card ref alone, so a drag started from the detail-panel relations tree — the one source that registers through the `dragSession` singleton without writing the card ref — never produced a drop intent. The drop then silently fell back to a column status change (or nothing at all). Both handlers now use the same `dragSession.get()` fallback that `handleDrop` already used, and the children-zone handler is no longer gated on board-only `isDragging` state, so the zone stops swallowing the `dragover`.

Reported as a shipped regression after the previous kanban drop-state release; covered by new `KanbanBoard.session-drag` tests.
