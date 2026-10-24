---
"@vibeflow-tools/ui": patch
---

Dragging a card near the edge of a wrapped board now autoscrolls vertically, so lanes below the fold are reachable mid-drag. Previously the scroll targeted the horizontal axis, which never overflows on wrapped boards, and the drag went nowhere.
