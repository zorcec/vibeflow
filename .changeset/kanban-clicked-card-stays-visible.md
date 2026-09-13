---
"@vibeflow-tools/cli": patch
---

Kanban: a task opened from the In Progress, Review or Done lane is no longer left hidden behind the detail panel.

The detail panel is an absolutely positioned overlay, so on a viewport narrower than board + panel it covers the card that was just clicked — and the board's own scroll range was too small to bring that card back (at 1440x900 it was 64px), leaving closing the panel as the only recovery. The board is now inset by the panel's live width while the panel is open, and the clicked card is scrolled into the visible band once, restoring the previous scroll position when the panel closes. Wide viewports where nothing is covered are unaffected.
