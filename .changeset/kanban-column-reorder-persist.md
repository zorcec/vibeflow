---
"@vibeflow-tools/cli": patch
---

Kanban board drag & drop: reordering cards in a column now persists the intended order.

- A column reorder uses the shared `computeReorder` plan, but only the dragged card's `sortKey` was written back — the plan's normalization patches (which assign real keys to keyless siblings) were applied to local state only. Since a task without a `sortKey` always sorts after every keyed task, the dragged card jumped to the top of the column on the next load, so the drop silently did nothing. The reorder now persists the dragged card plus every normalization patch, and a partial failure self-heals by reloading.
- The same normalization is now applied when a card is dragged out of a parent onto a column background, so it lands at the bottom of a mostly-keyless column instead of jumping above it.
