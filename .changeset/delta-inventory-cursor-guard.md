---
"@vibeflow-tools/cli": patch
---

**A stalled delta push now fails loudly instead of reporting a partial board as converged.**

`vibeflow push` reads the board's inventory page by page. A server that kept
returning the same cursor (or an empty page with a cursor still set) made that
loop re-read the same window until its ~10,000-page cap and then hand back a
partial inventory — so a push could announce "already on the board" for tasks
it never saw. Pagination now refuses a non-advancing cursor, refuses an empty
page that still asks for another page, and refuses a partial inventory at the
cap, all with an explicit error naming the stalled cursor.
