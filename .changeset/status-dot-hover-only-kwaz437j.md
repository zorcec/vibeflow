---
"@vibeflow-tools/ui": patch
---

The kanban status dot's tooltip is hover-only: the dot is no longer keyboard-focusable, since no browser opens tooltips on keyboard focus and the extra tab stop had no behavior. Nothing is lost for keyboard or screen-reader users — the status name stays in the accessible name.
