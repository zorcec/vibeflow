---
"@vibeflow-tools/ui": patch
---

Fixed the kanban board crashing with "Maximum update depth exceeded" when badge-overflow fitting failed to settle. The fit now measures a stable width and only re-runs when its inputs change; badge fitting behavior is unchanged.
