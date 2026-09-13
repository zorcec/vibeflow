---
"@vibeflow-tools/cli": patch
---

Fix the kanban board's centre drop (make-child) on normal-height cards. The reorder bands above and below a card were clamped to a 32px minimum with no cap, so on any card 64px or shorter the two bands overlapped and consumed the whole card: every drop classified as top or bottom, and dropping on the centre of a card silently reordered instead of nesting the task as a child. The bands are now capped so a centre zone always remains, while edge drops near the top or bottom still reorder.
