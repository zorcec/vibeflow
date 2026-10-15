---
"@vibeflow-tools/ui": patch
---

Card badges now always stay on a single line. Type, priority, assignee and tag pills render in one nowrap row that measures its own fit; once badges no longer fit, only those that fit show plus a "..." chip, and the rest stack one after another in a hover/focus/click tooltip. The chip's accessible name lists every hidden badge, and tooltips never cover the card's action buttons.
