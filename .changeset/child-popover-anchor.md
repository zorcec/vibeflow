---
"@vibeflow-tools/ui": patch
---

Hovering a parent card's subtask chip now opens the children preview next to the chip. Cards with many subtasks previously showed the preview pinned to the top of the viewport: the position estimate counted every subtask while only the first few rows render, so the popover flipped away from its anchor on a phantom height. The estimate now mirrors what actually renders (visible rows plus header, capped like the stylesheet), so the preview stays adjacent to the chip and inside the viewport.
