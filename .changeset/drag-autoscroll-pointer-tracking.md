---
"@vibeflow-tools/cli": patch
---

Fix the board's edge auto-scroll going quiet mid-drag at narrow viewports.

The auto-scroll loop tracked the pointer from `dragover` alone, but Chromium fires `dragover` only over targets that accepted the drag and fires no drag event at all while the pointer is stationary — so the tracked position could go stale outside the 60px edge band while the user kept moving toward it. Measured at a 900px viewport: the last `dragover` landed exactly on the band boundary, the pointer held 40px from the right edge, and the board never scrolled — the done lane stayed unreachable during the drag even though scrolling to the end brings it fully into view. The loop now tracks `drag`, `dragenter` and `dragover`, so a held drag at the edge keeps scrolling until the board cannot scroll further.
