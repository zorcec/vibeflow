---
"@vibeflow-tools/ui": patch
---

Blend the detail-panel type picker into the title field and fix the card badge-overflow tooltip. The task-type picker is now an inline leading segment inside the title input's bounds (one shared border) instead of a detached widget. The badge-overflow chip shows an explicit `+N` count with a chevron instead of a bare `…`, and its tooltip anchors to the chip via the shared popover helper so it stays inside the viewport instead of clipping.
