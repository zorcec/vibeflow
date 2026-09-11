---
"@vibeflow-tools/cli": patch
---

Move DeleteConfirmDialog to shared @vibeflow-tools/ui/kanban package so both CLI and web use the same radio-list delete confirmation component. Web app re-exports from shared (deletes stale local copy).
