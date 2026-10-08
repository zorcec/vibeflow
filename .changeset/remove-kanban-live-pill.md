---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Remove the "live" connection pill from the kanban board header

The header no longer shows the green live-status pill next to the project
name. The board still reconnects automatically in the background; only the
badge itself is gone, leaving a cleaner header.
