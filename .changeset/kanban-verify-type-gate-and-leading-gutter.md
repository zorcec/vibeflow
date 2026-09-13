---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

The verification badge is no longer shown on Research tasks. The verdict gate was scoped to the review and done lanes but never looked at the task's type, so a Research task that carried a `verified` value rendered the amber "failed verification" glyph — a verdict about a UI change that Research tasks never make (they produce a findings report, not code). The gate is now one predicate, read by the cards and the child rows alike, that requires a verdict lane AND a type that can be verified: Research is excluded, and the stored values are left untouched (only their display stops). Every other type the store carries still shows its verdict — Enhancement, Feature and Chore, and the tasks with no type at all, which resolve to the generic Task everywhere else in the board.

The leading status slot is no longer reserved in a lane that draws no mark. The slot's width was reserved unconditionally so that titles could not shift between cards of the same lane (the "3 marks / title moves 27px" fix), which left an empty 11px gutter before the title of any card with no mark — and an empty 12px one in the single-row (done and compact) layout, whose lane-dot fallback had a colour but no box and so rendered 0px wide. The reservation is now decided once per lane: a lane that draws at least one mark keeps reserving for all of its cards, so their titles stay aligned; a lane that draws none reserves nothing and its titles sit flush. The row layout's lane dot now has a real 7px box.
