---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

The children popover now uses the viewport instead of half of it, so a tall child list is actually readable: the 30-row cap shipped in 0.27.2 was still clamped to a 50vh box, which showed roughly half the rows on a normal screen. The popover picks the roomier side of its chip, never covers the anchor it hangs from, keeps its header and "+N more" affordance pinned, and snaps its height to whole rows so the list does not end mid-row.
