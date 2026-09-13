---
"@vibeflow-tools/cli": patch
---

Fix the empty leading gutter on unverified cards.

In a lane where any card shows a verdict, every card reserved an 11px slot — including cards with no verdict, which rendered an empty box that looked like a badge that had failed to load.

The space is still reserved, because a lane's titles must share one x-offset. It is now an invisible, non-semantic spacer rather than a mark box: `data-role="leading-slot"` exists only when a mark is actually painted.
