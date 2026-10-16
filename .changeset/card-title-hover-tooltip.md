---
"@vibeflow-tools/ui": patch
---

Kanban cards: a truncated card title now reveals its full text on hover in a width-limited, multi-line tooltip
(max-width 240px, wraps, matching the existing popover tokens). Titles that fit get no tooltip; the tip appears
only while the title is actually truncated and disappears on mouseleave.
