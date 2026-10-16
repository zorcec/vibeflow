---
"@vibeflow-tools/ui": patch
"@vibeflow-tools/cli": patch
---

Activity feed names the actual tags added and removed (e.g. "added: bug, ui · removed: p1") instead of a generic "changed tags" row. The diff is recorded at the write path (`diffTaskFields` and the detail panel now carry the added/removed arrays, diffed from the real tag strings so comma-containing tags stay exact); rows recorded before this change derive the same diff from their stored from/to keys, so no old entry renders generic anymore. Field-change entries are in-session only — a board reload starts with no field rows, as before.
