---
"@vibeflow-tools/cli": patch
---

fix(kanban): add vertical scrollbar to lanes except Done

Lanes now have `overflow-y: auto` so tasks are scrollable when they exceed the viewport height. The Done lane keeps `overflow-y: hidden` since it already limits visible cards to 20.
