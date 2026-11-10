---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Show up to 30 child rows in the board's children popover (previously 6) before truncating. The truncation line is now a keyboard-reachable "+N more" button that opens the task's detail panel scrolled to the full children list, instead of passive text. At 30 rows the popover clamps to its 50vh budget and the row list scrolls internally while the header and the affordance stay pinned.
