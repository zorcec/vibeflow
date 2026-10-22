---
"@vibeflow-tools/ui": patch
---

Wrapped-board drag autoscroll (ticket s5dfufqs, R10): the loop wrote `board.scrollLeft` unconditionally, but the wrapped board never overflows horizontally (`overflow-x: hidden`, lanes fit or wrap) — a dead write — while wrapped lanes below the fold scrolled nothing. The board now scrolls on the axis that actually overflows via `boardAutoScrollDelta` (vertical-only on the shipped board, zero when nothing overflows); lane `.column-scroll` vertical autoscroll is unchanged.
