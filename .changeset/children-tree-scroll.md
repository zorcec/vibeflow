---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

The expanded children tree no longer cuts a row in half. It shows 30 whole rows and scrolls inside the card for larger families, so every child is reachable — 60 children used to be clipped at 19 with the 20th sliced and the rest unreachable, because the inner wrapper had `overflow: hidden` rather than the scroll container itself. The children popover drops the "+N more" button entirely: it renders every child and scrolls the list instead of hiding rows behind a control.
