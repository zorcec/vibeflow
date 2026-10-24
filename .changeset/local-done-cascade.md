---
"@vibeflow-tools/cli": minor
---

In local mode, marking a parent task `done` now cascades `done` to all descendants in the same edit. Already-done descendants are left untouched, cycles terminate, and marking a child `done` never touches its parent.
