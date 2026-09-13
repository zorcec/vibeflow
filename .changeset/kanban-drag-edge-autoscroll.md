---
"@vibeflow-tools/cli": patch
---

Fix drag reachability: auto-scroll the board and lanes when a dragged card nears an edge.

Dragging a task to a column or row that was off-screen was previously impossible — there was no edge auto-scroll, so a lane taller or wider than the viewport (the Done column is clipped at 1310px) could not be reached at all. Dragging now scrolls the board horizontally and the lane under the pointer vertically, with the speed ramping up as the pointer approaches the edge.

The scroll zone is 60px with a maximum of 14px per frame. A pointer held outside the container counts as full penetration rather than stopping the scroll.
