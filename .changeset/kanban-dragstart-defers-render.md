---
"@vibeflow-tools/cli": patch
---

Dragging a kanban card no longer aborts the moment it starts. The dragstart handler updated React state synchronously, and React flushes those updates inside the very dispatch Chromium uses to initiate the native drag — the resulting board re-render (child drop slots inserted into every childless card, column restyling) raced the drag-image capture and killed the session. The drag then ended a few pixels in with no `dragenter`, `dragover` or `drop`, so nothing could be reordered or moved and no request was ever sent. The drag source is now registered synchronously in refs and the drag session, and every rendering side effect (the drag highlight, hover intent, source state) is deferred by one macrotask, after the browser owns the drag. Reordering, cross-column moves, make-child and tree drags all behave as before.
