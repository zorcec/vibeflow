---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

The board type filter offers exactly three canonical options: Bug, Task, Research. Tasks stored under legacy aliases (Feature and Enhancement) now appear under Task instead of being silently hidden. The CLI kanban board matches on the canonical type too.
